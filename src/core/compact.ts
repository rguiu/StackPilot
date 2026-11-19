// Compaction: replace the sent conversation with a summary, append-only.
//
// The compact request is a PURE APPEND to the cached prefix — same tools,
// same system, same history, plus one instruction message — so the whole
// conversation bills at cache-read rates (see docs/protocol/compaction.md
// for the recorded Claude Code behavior this mirrors). The summary is then
// persisted as a user event flagged isCompactSummary; the reducer starts
// the API-visible conversation at the last such flag. Nothing is deleted.

import { reduce, toApiMessages } from "./reducer.js";
import { applyCacheControl } from "./cache.js";
import { computeCostUsd, resolveRates } from "./cost.js";
import { runHook, type HookConfig } from "./hooks.js";
import { textOf, accumulateUsage } from "../util/message.js";
import type { ContentBlock } from "../types.js";
import type { ModelPricing } from "../config.js";
import type { SessionStore } from "../session/store.js";
import type { Registry } from "../tools/index.js";
import type {
  MessagesRequest,
  StreamResult,
  TransportConfig,
  UsageInfo,
} from "../transport/anthropic.js";

export const COMPACT_INSTRUCTION = [
  "Respond with plain text only. Do NOT call any tools — the schemas are",
  "attached solely to keep the cached prefix intact.",
  "",
  "Write a continuation summary of this entire conversation so a fresh",
  "session can resume the work seamlessly. Use exactly these sections:",
  "",
  "## Goal",
  "What the user is ultimately trying to achieve.",
  "",
  "## State",
  "What has been done: files created or modified (with paths), commands",
  "run, decisions taken and why.",
  "",
  "## Key context",
  "Technical details that must not be lost: APIs, schemas, conventions,",
  "constraints, gotchas discovered.",
  "",
  "## Next steps",
  "Pending work in order, with enough detail to execute.",
  "",
  "Reply with ONLY this summary — no preamble, no closing remarks.",
].join("\n");

export function buildCompactRequest(
  system: string,
  tools: unknown[],
  messages: { role: "user" | "assistant"; content: ContentBlock[] }[],
  ttl?: "5m" | "1h",
): MessagesRequest {
  return applyCacheControl(
    system,
    tools,
    [
      ...messages,
      {
        role: "user",
        content: [{ type: "text", text: COMPACT_INSTRUCTION }],
      },
    ],
    ttl,
  );
}

export interface CompactDeps {
  store: SessionStore;
  registry: Registry;
  config: TransportConfig;
  system: string;
  pricing?: Record<string, ModelPricing>;
  signal?: AbortSignal;
  hooks?: {
    preCompact?: HookConfig;
    postCompact?: HookConfig;
  };
  // Compaction rounds a progressively-activated tool can go unused before
  // it's deactivated again. 0/undefined disables contraction.
  toolContractionRounds?: number;
  // Hard cap (chars) on the summary before compression/truncation kicks in.
  // 0/undefined disables.
  compactSummaryMaxChars?: number;
  stream: (
    cfg: TransportConfig,
    req: MessagesRequest,
    onText: (d: string) => void,
    signal?: AbortSignal,
  ) => Promise<StreamResult>;
}

export interface CompactResult {
  totalMessages: number;
  summaryChars: number;
  usage: UsageInfo;
  costUsd: number | null;
  // Tools deactivated by tool-pool contraction this round, if any.
  contractedTools: string[];
  // Whether the summary needed compression/truncation to fit the cap.
  compressed: boolean;
}

// Returns null when there is nothing to compact. Throws on an unusable
// response (empty summary) — the tree is untouched in that case.
export async function runCompact(
  deps: CompactDeps,
): Promise<CompactResult | null> {
  const { store, registry, config, system } = deps;
  const compactConfig = config.cheapModel
    ? { ...config, model: config.cheapModel }
    : config;
  const reduced = reduce(store.all());
  if (reduced.messages.length === 0) return null;

  await runHook(
    "pre_compact",
    deps.hooks?.preCompact,
    store.sessionId,
    process.cwd(),
  );

  const request = buildCompactRequest(
    system,
    registry.schemas(),
    toApiMessages(reduced.messages),
    compactConfig.cacheTtl,
  );
  const result = await deps.stream(
    compactConfig,
    request,
    () => {},
    deps.signal,
  );

  const summary = textOf(result.content).trim();
  if (summary.length === 0) {
    throw new Error(
      "compaction returned no summary text (model may have attempted a tool call)",
    );
  }

  const usage = {
    input_tokens: result.usage.input_tokens ?? 0,
    output_tokens: result.usage.output_tokens ?? 0,
    cache_read_input_tokens: result.usage.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: result.usage.cache_creation_input_tokens ?? 0,
  };
  let finalSummary = summary;
  let compressed = false;
  const cap = deps.compactSummaryMaxChars ?? 0;
  if (cap > 0 && summary.length > cap) {
    compressed = true;
    finalSummary = await compressSummary(
      summary,
      cap,
      compactConfig,
      deps.stream,
      usage,
      deps.signal,
    );
  }

  store.append({
    type: "user",
    parentUuid: reduced.leafUuid,
    isCompactSummary: true,
    message: {
      role: "user",
      content: [{ type: "text", text: finalSummary }],
      usage,
    },
  });

  await runHook(
    "post_compact",
    deps.hooks?.postCompact,
    store.sessionId,
    process.cwd(),
  );

  const contractedTools =
    deps.toolContractionRounds && deps.toolContractionRounds > 0
      ? registry.contractDisused(deps.toolContractionRounds)
      : [];

  const rates = deps.pricing ? resolveRates(result.model, deps.pricing) : null;
  return {
    totalMessages: reduced.messages.length,
    summaryChars: finalSummary.length,
    usage,
    costUsd: rates ? computeCostUsd(usage, rates) : null,
    contractedTools,
    compressed,
  };
}

// One follow-up call on the compaction model asking it to compress an
// over-cap summary while preserving its section headers. Never throws — a
// compaction must not fail just because the summary was long, so any
// failure (or a still-over-cap result) falls back to a hard truncate.
async function compressSummary(
  summary: string,
  cap: number,
  compactConfig: TransportConfig,
  stream: CompactDeps["stream"],
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  },
  signal?: AbortSignal,
): Promise<string> {
  try {
    const result = await stream(
      compactConfig,
      {
        system: `Compress the following continuation summary to fit within ${cap} characters, preserving its "## Goal", "## State", "## Key context", and "## Next steps" sections. Reply with ONLY the compressed summary — no preamble, no closing remarks.`,
        tools: [],
        messages: [
          { role: "user", content: [{ type: "text", text: summary }] },
        ],
      },
      () => {},
      signal,
    );
    accumulateUsage(usage, result.usage);
    const compact = textOf(result.content).trim();
    if (compact.length > 0 && compact.length <= cap) return compact;
  } catch {
    // fall through to hard truncate
  }
  return summary.slice(0, cap);
}
