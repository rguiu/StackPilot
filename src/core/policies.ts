// Context policies: pure transformations on the API message stack.
// Applied before each API request to reduce token consumption.

import { sha256Truncated } from "../util/hash.js";
import type { ToolResultBlock, ToolUseBlock, ContentBlock } from "../types.js";

export interface SessionState {
  readonly pagedOutputs: Map<string, string>;
  readonly readCache: Map<string, { hash: string; content: string }>;
}

const DEFAULT_MAX_TOOL_RESULT_CHARS = 10_000;

const isToolResult = (block: ContentBlock): block is ToolResultBlock =>
  block.type === "tool_result";

const isToolUse = (block: ContentBlock): block is ToolUseBlock =>
  block.type === "tool_use";

// --- Tool-result paging ----------------------------------------------------

export function pageToolResults(
  messages: { role: "user" | "assistant"; content: ContentBlock[] }[],
  state: SessionState,
  maxChars: number = DEFAULT_MAX_TOOL_RESULT_CHARS,
): void {
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    for (const block of msg.content) {
      if (!isToolResult(block)) continue;
      if (typeof block.content !== "string") continue;
      if (block.content.length <= maxChars) continue;
      if (!block.tool_use_id) continue;
      state.pagedOutputs.set(block.tool_use_id, block.content);
      const head = block.content.slice(0, maxChars);
      block.content = `${head}\n\n[truncated ${block.content.length - maxChars} of ${block.content.length} chars — use ReadMore to expand]`;
    }
  }
}

// --- Read deduplication ----------------------------------------------------

export function deduplicateReads(
  messages: { role: "user" | "assistant"; content: ContentBlock[] }[],
  state: SessionState,
): void {
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

  for (const msg of messages) {
    if (msg.role !== "user") continue;
    for (const block of msg.content) {
      if (!isToolResult(block)) continue;
      if (!block.tool_use_id) continue;
      const toolUse = assistantBlocks.get(block.tool_use_id);
      if (!toolUse) continue;
      const filePath = toolUse.input.file_path as string;
      if (!filePath) continue;
      if (typeof block.content !== "string") continue;

      const hash = sha256Truncated(block.content);
      const cached = state.readCache.get(filePath);
      if (cached && cached.hash === hash) {
        block.content = `[unchanged from previous read — ${block.content.length} chars]`;
      } else {
        state.readCache.set(filePath, { hash, content: block.content });
      }
    }
  }
}

// --- Stack eviction --------------------------------------------------------

export function evictOldResults(
  messages: { role: "user" | "assistant"; content: ContentBlock[] }[],
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
        if (!older) continue;
        for (const block of older.content) {
          if (!isToolResult(block)) continue;
          block.content = "[evicted]";
        }
      }
      break;
    }
  }
}
