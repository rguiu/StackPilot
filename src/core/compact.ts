// Compaction: replace the sent conversation with a summary, append-only.
//
// The compact request is a PURE APPEND to the cached prefix — same tools,
// same system, same history, plus one instruction message — so the whole
// conversation bills at cache-read rates (see docs/protocol/compaction.md
// for the recorded Claude Code behavior this mirrors). The summary is then
// persisted as a user event flagged isCompactSummary; the reducer starts
// the API-visible conversation at the last such flag. Nothing is deleted.

import { reduce, toApiMessages } from "./reducer.js";
import { applyCacheControl, type CacheLedger } from "./cache.js";
import { computeCostUsd, resolveRates } from "./cost.js";
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
  messages: { role: "user" | "assistant"; content: unknown }[],
): MessagesRequest {
  return applyCacheControl(system, tools, [
    ...messages,
    {
      role: "user",
      content: [{ type: "text", text: COMPACT_INSTRUCTION }],
    },
  ]);
}

export interface CompactDeps {
  store: SessionStore;
  registry: Registry;
  config: TransportConfig;
  system: string;
  ledger?: CacheLedger;
  pricing?: Record<string, ModelPricing>;
  signal?: AbortSignal;
  stream(
    cfg: TransportConfig,
    req: MessagesRequest,
    onText: (d: string) => void,
    signal?: AbortSignal,
  ): Promise<StreamResult>;
}

export interface CompactResult {
  droppedMessages: number;
  summaryChars: number;
  usage: UsageInfo;
  costUsd: number | null;
}

function textOf(content: unknown[]): string {
  return content
    .map((b) =>
      typeof b === "object" &&
      b !== null &&
      (b as { type?: string }).type === "text"
        ? ((b as { text?: string }).text ?? "")
        : "",
    )
    .join("");
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

  const request = buildCompactRequest(
    system,
    registry.schemas(),
    toApiMessages(reduced.messages),
  );
  deps.ledger?.beforeRequest(request);
  const result = await deps.stream(
    compactConfig,
    request,
    () => {},
    deps.signal,
  );
  deps.ledger?.afterResponse(result.usage);

  const summary = textOf(result.content).trim();
  if (summary.length === 0) {
    throw new Error(
      "compaction returned no summary text (model may have attempted a tool call)",
    );
  }

  store.append({
    type: "user",
    parentUuid: reduced.leafUuid,
    isCompactSummary: true,
    message: {
      role: "user",
      content: [{ type: "text", text: summary }],
      usage: result.usage,
    },
  });

  const rates = deps.pricing ? resolveRates(result.model, deps.pricing) : null;
  return {
    droppedMessages: reduced.messages.length,
    summaryChars: summary.length,
    usage: result.usage,
    costUsd: rates ? computeCostUsd(result.usage, rates) : null,
  };
}
