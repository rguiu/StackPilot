// Context policies: pure transformations on the API message stack.
// Applied before each API request to reduce token consumption.

import { sha256Truncated } from "../util/hash.js";
import type { ToolResultBlock, ToolUseBlock } from "../types.js";

export interface SessionState {
  readonly pagedOutputs: Map<string, string>;
  readonly readCache: Map<string, { hash: string; content: string }>;
}

const DEFAULT_MAX_TOOL_RESULT_CHARS = 10_000;

const isToolResult = (
  block: unknown,
): block is Record<keyof ToolResultBlock, unknown> =>
  typeof block === "object" &&
  block !== null &&
  (block as { type?: unknown }).type === "tool_result";

const isToolUse = (
  block: unknown,
): block is Record<keyof ToolUseBlock, unknown> =>
  typeof block === "object" &&
  block !== null &&
  (block as { type?: unknown }).type === "tool_use";

// --- Tool-result paging ----------------------------------------------------

export function pageToolResults(
  messages: { role: "user" | "assistant"; content: unknown }[],
  state: SessionState,
  maxChars: number = DEFAULT_MAX_TOOL_RESULT_CHARS,
): void {
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!isToolResult(block)) continue;
      const b = block as ToolResultBlock;
      if (typeof b.content !== "string") continue;
      if (b.content.length <= maxChars) continue;
      if (!b.tool_use_id) continue;
      state.pagedOutputs.set(b.tool_use_id, b.content);
      const head = b.content.slice(0, maxChars);
      b.content = `${head}\n\n[truncated ${b.content.length - maxChars} of ${b.content.length} chars — use ReadMore to expand]`;
    }
  }
}

// --- Read deduplication ----------------------------------------------------

export function deduplicateReads(
  messages: { role: "user" | "assistant"; content: unknown }[],
  state: SessionState,
): void {
  const assistantBlocks: Map<string, { input: Record<string, unknown> }> =
    new Map();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!isToolUse(block)) continue;
      const b = block as ToolUseBlock;
      if (b.name === "Read" && b.id) {
        assistantBlocks.set(b.id, { input: b.input });
      }
    }
  }

  for (const msg of messages) {
    if (msg.role !== "user") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!isToolResult(block)) continue;
      const b = block as ToolResultBlock;
      if (!b.tool_use_id) continue;
      const toolUse = assistantBlocks.get(b.tool_use_id);
      if (!toolUse) continue;
      const filePath = toolUse.input.file_path as string;
      if (!filePath) continue;
      if (typeof b.content !== "string") continue;

      const hash = sha256Truncated(b.content);
      const cached = state.readCache.get(filePath);
      if (cached && cached.hash === hash) {
        b.content = `[unchanged from previous read — ${b.content.length} chars]`;
      } else {
        state.readCache.set(filePath, { hash, content: b.content });
      }
    }
  }
}

// --- Stack eviction --------------------------------------------------------

export function evictOldResults(
  messages: { role: "user" | "assistant"; content: unknown }[],
  keepTurns: number = 5,
): void {
  let pairCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role === "user") pairCount++;
    if (pairCount >= keepTurns) {
      for (let j = 0; j < i; j++) {
        const older = messages[j];
        if (!older || !Array.isArray(older.content)) continue;
        for (const block of older.content) {
          if (!isToolResult(block)) continue;
          const b = block as ToolResultBlock;
          b.content = "[evicted]";
        }
      }
      break;
    }
  }
}
