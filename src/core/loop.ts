// Agent turn orchestration. Owns the request→tool→request cycle; all
// dependencies are injected so the loop itself stays testable and free of
// direct I/O decisions.

import type { SessionStore } from "../session/store.js";
import { reduce } from "./reducer.js";
import { applyCacheControl, type CacheLedger } from "./cache.js";
import { computeCostUsd, resolveRates } from "./cost.js";
import {
  pageToolResults,
  deduplicateReads,
  evictOldResults,
  type SessionState,
} from "./policies.js";
import type { ModelPricing } from "../config.js";
import type {
  MessagesRequest,
  StreamResult,
  TransportConfig,
  UsageInfo,
} from "../transport/anthropic.js";
import { executeTool, type Registry } from "../tools/index.js";
import { runHook, type HookConfig } from "./hooks.js";
import { toolUses, accumulateUsage } from "../util/message.js";
import type { ToolUseBlock, ContentBlock } from "../types.js";
import type { ToolResultBlock } from "../types.js";

export interface TurnIO {
  onText(delta: string): void;
  onToolStart(name: string, input: Record<string, unknown>): void;
  onToolEnd(name: string, output: string, isError: boolean): void;
  // Permission gate: resolved → allowed, optional denial reason.
  // Read-only tools bypass this entirely.
  permit(
    name: string,
    input: Record<string, unknown>,
  ): Promise<{ allowed: boolean; reason?: string }>;
}

export interface TurnDeps {
  cwd: string;
  store: SessionStore;
  registry: Registry;
  config: TransportConfig;
  system: string;
  io: TurnIO;
  // Cache awareness (§4.4 of IMPLEMENTATION.md): predicts hits before each
  // request and reconciles with the server's usage counters after. Owned by
  // the caller so it spans turns.
  ledger?: CacheLedger;
  // Pricing tables keyed by server-reported model id; when provided, turn
  // cost is computed per request (unknown model → costUsd null + one note).
  pricing?: Record<string, ModelPricing>;
  // Optional interrupt (Esc in the TUI). Aborting mid-stream discards the
  // in-flight assistant turn; the event tree stays consistent because events
  // are only appended after a request completes.
  signal?: AbortSignal;
  // Shared mutable state for context policies (paging, dedup, eviction).
  sessionState?: SessionState;
  // Max chars per tool_result before paging kicks in. 0 = no paging.
  maxToolResultChars?: number;
  // Hook configs keyed by point ("pre-tool" / "post-tool"). Undefined hooks
  // are skipped (no-op). Hook stdout is collected and injected as a
  // <system-reminder> into the next user message.
  hooks?: {
    preTool?: HookConfig;
    postTool?: HookConfig;
    sessionStart?: HookConfig;
    sessionEnd?: HookConfig;
  };
  stream(
    cfg: TransportConfig,
    req: MessagesRequest,
    onText: (d: string) => void,
    signal?: AbortSignal,
  ): Promise<StreamResult>;
}

export interface TurnStats {
  requests: number;
  toolCalls: number;
  usage: Required<Pick<UsageInfo, "input_tokens" | "output_tokens">> & {
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  // Cache verdicts worth surfacing (regens, misses) — empty on clean turns.
  notes: string[];
  // Dollar cost of the turn; null when no/incomplete pricing is available.
  costUsd: number | null;
  // Total input tokens (fresh + cache read + cache write) of the LAST
  // request — the auto-compaction trigger metric.
  lastRequestInputTokens: number;
  hookReminders: string[];
}

function deepCloneContent(content: ContentBlock[]): ContentBlock[] {
  return JSON.parse(JSON.stringify(content)) as ContentBlock[];
}

const MAX_ITERATIONS = 40;

function withReminders(
  results: ToolResultBlock[],
  reminders: string[],
): ContentBlock[] {
  if (reminders.length === 0) return results;
  const blocks: ContentBlock[] = reminders.map((text) => ({
    type: "text" as const,
    text,
  }));
  reminders.length = 0;
  return [...blocks, ...results];
}

export async function runTurn(
  deps: TurnDeps,
  userText: string,
): Promise<TurnStats> {
  const { store, registry, config, system, io } = deps;
  const stats: TurnStats = {
    requests: 0,
    toolCalls: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    notes: [],
    costUsd: null,
    lastRequestInputTokens: 0,
    hookReminders: [],
  };
  let priceIncomplete = false;

  let leaf = reduce(store.all()).leafUuid;
  const userEvent = store.append({
    type: "user",
    parentUuid: leaf,
    message: { role: "user", content: [{ type: "text", text: userText }] },
  });
  if (!userEvent.uuid) throw new Error("store.append returned no uuid");
  leaf = userEvent.uuid;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const reduced = reduce(store.all());
    const apiMessages = reduced.messages.map((m) => ({
      role: m.role,
      content: deepCloneContent(m.content),
    }));

    if (deps.sessionState) {
      if (deps.maxToolResultChars && deps.maxToolResultChars > 0) {
        pageToolResults(
          apiMessages,
          deps.sessionState,
          deps.maxToolResultChars,
        );
      }
      deduplicateReads(apiMessages, deps.sessionState);
      evictOldResults(apiMessages);
    }

    const request = applyCacheControl(system, registry.schemas(), apiMessages);
    deps.ledger?.beforeRequest(request);
    stats.requests++;
    const result = await deps.stream(
      config,
      request,
      (d) => {
        io.onText(d);
      },
      deps.signal,
    );
    accumulateUsage(stats.usage, result.usage);
    stats.lastRequestInputTokens =
      (result.usage.input_tokens ?? 0) +
      (result.usage.cache_read_input_tokens ?? 0) +
      (result.usage.cache_creation_input_tokens ?? 0);
    if (deps.pricing && !priceIncomplete) {
      const rates = resolveRates(result.model, deps.pricing);
      if (rates === null) {
        stats.notes.push(`no pricing for model ${result.model ?? "(unknown)"}`);
        stats.costUsd = null;
        priceIncomplete = true;
      } else {
        stats.costUsd =
          (stats.costUsd ?? 0) + computeCostUsd(result.usage, rates);
      }
    }
    const verdict = deps.ledger?.afterResponse(result.usage);
    if (verdict?.note) stats.notes.push(verdict.note);

    const assistantEvent = store.append({
      type: "assistant",
      parentUuid: leaf,
      message: {
        role: "assistant",
        content: result.content,
        usage: result.usage,
      },
    });
    if (!assistantEvent.uuid) throw new Error("store.append returned no uuid");
    leaf = assistantEvent.uuid;

    const uses = toolUses(result.content);
    if (result.stopReason !== "tool_use" || uses.length === 0) break;

    const results: ToolResultBlock[] = [];
    try {
      for (const use of uses) {
        results.push(await dispatchTool(deps, use, stats));
      }
    } catch (err) {
      // Invariant: an assistant tool_use block stored in the tree MUST get a
      // tool_result sibling, or every future request on this path is
      // rejected by the API. On interrupt/crash mid-phase, backfill
      // synthetic results for whatever didn't finish, then rethrow.
      const done = new Set(results.map((r) => r.tool_use_id));
      for (const use of uses) {
        if (!done.has(use.id)) {
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            content: "[interrupted by user]",
            is_error: true,
          });
        }
      }
      store.append({
        type: "user",
        parentUuid: leaf,
        message: {
          role: "user",
          content: withReminders(results, stats.hookReminders),
        },
      });
      throw err;
    }
    const toolResultEvent = store.append({
      type: "user",
      parentUuid: leaf,
      message: {
        role: "user",
        content: withReminders(results, stats.hookReminders),
      },
    });
    if (!toolResultEvent.uuid) throw new Error("store.append returned no uuid");
    leaf = toolResultEvent.uuid;

    if (i === MAX_ITERATIONS - 1) {
      stats.notes.push(
        `reached max iterations (${MAX_ITERATIONS}) — turn truncated`,
      );
    }
  }

  return stats;
}

async function dispatchTool(
  deps: TurnDeps,
  use: ToolUseBlock,
  stats: TurnStats,
): Promise<ToolResultBlock> {
  const { registry, io, store } = deps;
  const input = use.input;
  const def = registry.get(use.name);
  stats.toolCalls++;

  let output = "";
  let isError = false;

  if (!def) {
    output = `unknown tool: ${use.name}`;
    isError = true;
  } else if (!registry.isEnabled(use.name)) {
    output = `tool disabled for this session: ${use.name}`;
    isError = true;
  } else if (!def.runPermitless) {
    const perm = await io.permit(use.name, input);
    if (!perm.allowed) {
      output = perm.reason
        ? `user denied permission for this tool call: ${perm.reason}`
        : "user denied permission for this tool call";
      isError = true;
    }
  }

  if (!isError && def) {
    const sessionId = store.sessionId;
    const cwd = deps.cwd;
    const preResult = await runHook(
      "pre_tool",
      deps.hooks?.preTool,
      sessionId,
      cwd,
      use.name,
      input,
    );
    if (preResult && preResult.stdout) {
      stats.hookReminders.push(
        `<system-reminder>\n${preResult.stdout}\n</system-reminder>`,
      );
    }

    io.onToolStart(use.name, input);
    const result = await executeTool(def, input, deps.cwd);
    output = result.output;
    isError = result.isError === true;
    io.onToolEnd(use.name, output, isError);

    const postResult = await runHook(
      "post_tool",
      deps.hooks?.postTool,
      sessionId,
      cwd,
      use.name,
      input,
    );
    if (postResult && postResult.stdout) {
      stats.hookReminders.push(
        `<system-reminder>\n${postResult.stdout}\n</system-reminder>`,
      );
    }
  }

  return {
    type: "tool_result",
    tool_use_id: use.id,
    content: output,
    ...(isError ? { is_error: true } : {}),
  };
}
