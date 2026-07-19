// Context policies: pure transformations on the API message stack.
// Applied before each API request to reduce token consumption. Every
// function returns a NEW array — never mutates its inputs — so the
// session store's in-memory view and the API prefix are kept stable
// across turns (critical for Anthropic prompt caching).

import { sha256Truncated } from "../util/hash.js";
import type { ToolResultBlock, ToolUseBlock, ContentBlock } from "../types.js";

export interface SessionState {
  readonly pagedOutputs: Map<string, string>;
  readonly readCache: Map<string, { hash: string; content: string }>;
}

type Message = { role: "user" | "assistant"; content: ContentBlock[] };

const DEFAULT_MAX_TOOL_RESULT_CHARS = 10_000;

const isToolResult = (block: ContentBlock): block is ToolResultBlock =>
  block.type === "tool_result";

const isToolUse = (block: ContentBlock): block is ToolUseBlock =>
  block.type === "tool_use";

// --- Tool-result paging ----------------------------------------------------

export function pageToolResults(
  messages: Message[],
  state: SessionState,
  maxChars: number = DEFAULT_MAX_TOOL_RESULT_CHARS,
): Message[] {
  return messages.map((msg) => {
    if (msg.role !== "user") return msg;
    const content = msg.content.map((block) => {
      if (!isToolResult(block)) return block;
      if (typeof block.content !== "string") return block;
      if (block.content.length <= maxChars) return block;
      if (!block.tool_use_id) return block;
      state.pagedOutputs.set(block.tool_use_id, block.content);
      const head = block.content.slice(0, maxChars);
      return {
        ...block,
        content: `${head}\n\n[truncated ${block.content.length - maxChars} of ${block.content.length} chars — use ReadMore to expand]`,
      };
    });
    if (content === msg.content) return msg;
    return { role: msg.role, content };
  });
}

// --- Read deduplication ----------------------------------------------------

// Applied at tool-execution time, before the result enters the event tree.
// Subsequent Read calls for the same file path with identical content are
// replaced with a short marker. Because this runs BEFORE storage, old
// blocks are never rewritten — the API prefix stays byte-stable.
export function deduplicateReadResult(
  filePath: string,
  result: string,
  state: SessionState,
): string {
  const hash = sha256Truncated(result);
  const cached = state.readCache.get(filePath);
  if (cached && cached.hash === hash) {
    return `[unchanged from previous read — ${result.length} chars]`;
  }
  state.readCache.set(filePath, { hash, content: result });
  return result;
}

// Deprecated post-hoc scanner — kept for subagent.ts which operates on
// ephemeral messages (no event tree, no cache concerns). Returns a new
// array; does not mutate input.
export function deduplicateReads(
  messages: Message[],
  state: SessionState,
): Message[] {
  const assistantBlocks: Map<string, { input: Record<string, unknown> }> =
    new Map();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (!isToolUse(block)) continue;
      if (block.name === "Read" && block.id) {
        assistantBlocks.set(block.id, { input: block.input });
      }
    }
  }

  return messages.map((msg) => {
    if (msg.role !== "user") return msg;
    const content = msg.content.map((block) => {
      if (!isToolResult(block)) return block;
      if (!block.tool_use_id) return block;
      const toolUse = assistantBlocks.get(block.tool_use_id);
      if (!toolUse) return block;
      const filePath = toolUse.input.file_path as string;
      if (!filePath) return block;
      if (typeof block.content !== "string") return block;

      const hash = sha256Truncated(block.content);
      const cached = state.readCache.get(filePath);
      if (cached && cached.hash === hash) {
        return {
          ...block,
          content: `[unchanged from previous read — ${block.content.length} chars]`,
        };
      }
      state.readCache.set(filePath, { hash, content: block.content });
      return block;
    });
    if (content === msg.content) return msg;
    return { role: msg.role, content };
  });
}

// --- Stack eviction (subagents only) ---------------------------------------

// Replaces tool results beyond the keep window with "[evicted]". Returns a
// new array — does not mutate. Only used in subagents (ephemeral messages,
// no prompt caching).
export function evictOldResults(
  messages: Message[],
  keepTurns: number = 5,
): Message[] {
  let pairCount = 0;
  let evictFrom = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role === "user") pairCount++;
    if (pairCount >= keepTurns) {
      evictFrom = i;
      break;
    }
  }
  if (evictFrom <= 0) return messages;

  return messages.map((msg, i) => {
    if (i >= evictFrom || msg.role !== "user") return msg;
    const content = msg.content.map((block) => {
      if (!isToolResult(block)) return block;
      return { ...block, content: "[evicted]" };
    });
    if (content === msg.content) return msg;
    return { role: msg.role, content };
  });
}

// --- Compaction signal -----------------------------------------------------

// Returns true when the message stack exceeds maxTurns user messages.
// Callers should trigger auto-compaction rather than inline eviction,
// since compaction creates a summary event (isCompactSummary) that the
// reducer restarts from — a clean, cache-stable boundary.
export function turnsExceeded(messages: Message[], maxTurns: number): boolean {
  let userCount = 0;
  for (const msg of messages) {
    if (msg.role === "user") userCount++;
  }
  return userCount > maxTurns;
}
