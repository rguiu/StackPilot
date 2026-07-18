// Context policies: pure transformations on the API message stack.
// Applied before each API request to reduce token consumption.

import { createHash } from "node:crypto";

export interface SessionState {
  readonly pagedOutputs: Map<string, string>;
  readonly readCache: Map<string, { hash: string; content: string }>;
}

const DEFAULT_MAX_TOOL_RESULT_CHARS = 10_000;

// --- Tool-result paging ----------------------------------------------------

// Truncates tool_result content blocks above maxChars. Stores the full
// content in state.pagedOutputs so ReadMore can expand them later.
// Returns the modified messages (same array, mutated in place).
export function pageToolResults(
  messages: { role: "user" | "assistant"; content: unknown }[],
  state: SessionState,
  maxChars: number = DEFAULT_MAX_TOOL_RESULT_CHARS,
): void {
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_result") continue;
      const content = b.content;
      if (typeof content !== "string") continue;
      if (content.length <= maxChars) continue;
      const id = b.tool_use_id as string;
      if (!id) continue;
      state.pagedOutputs.set(id, content);
      const head = content.slice(0, maxChars);
      b.content = `${head}\n\n[truncated ${content.length - maxChars} of ${content.length} chars — use ReadMore to expand]`;
    }
  }
}

// --- Read deduplication ----------------------------------------------------

// Detects unchanged file reads and replaces the tool_result content with
// a summary referencing the previous read. The first read is cached in
// state.readCache by (file_path, content hash).
export function deduplicateReads(
  messages: { role: "user" | "assistant"; content: unknown }[],
  state: SessionState,
): void {
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    if (!Array.isArray(msg.content)) continue;

    // Find any Read tool_use + tool_result pairs in this user message.
    // We need the assistant message (previous) to find the tool_use blocks.
  }
  // We need paired tool_use → tool_result. Re-process across messages.
  const assistantBlocks: Map<string, { input: Record<string, unknown> }> =
    new Map();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      const b = block as Record<string, unknown>;
      if (b.type === "tool_use" && b.name === "Read") {
        const id = b.id as string;
        if (id)
          assistantBlocks.set(id, {
            input: (b.input ?? {}) as Record<string, unknown>,
          });
      }
    }
  }

  for (const msg of messages) {
    if (msg.role !== "user") continue;
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      const b = block as Record<string, unknown>;
      if (b.type !== "tool_result") continue;
      const id = b.tool_use_id as string;
      if (!id) continue;
      const toolUse = assistantBlocks.get(id);
      if (!toolUse) continue;
      const filePath = toolUse.input.file_path as string;
      if (!filePath) continue;

      const content = b.content;
      if (typeof content !== "string") continue;

      const hash = sha(content);
      const cached = state.readCache.get(filePath);
      if (cached && cached.hash === hash) {
        b.content = `[unchanged from previous read — ${content.length} chars]`;
      } else {
        state.readCache.set(filePath, { hash, content });
      }
    }
  }
}

// --- Stack eviction --------------------------------------------------------

// Drops tool_result blocks from messages older than keepTurns turns. A
// "turn" is one assistant message + one user message. Preserves at least
// the last keepTurns pairs and any assistant messages without a matching
// user result.
export function evictOldResults(
  messages: { role: "user" | "assistant"; content: unknown }[],
  keepTurns: number = 5,
): void {
  // Walk backwards to find the cutoff point.
  let pairCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role === "user") pairCount++;
    if (pairCount >= keepTurns) {
      // Evict all tool_results in messages before this point.
      for (let j = 0; j < i; j++) {
        const older = messages[j];
        if (!older || !Array.isArray(older.content)) continue;
        for (const block of older.content) {
          const b = block as Record<string, unknown>;
          if (b.type === "tool_result") {
            b.content = "[evicted]";
          }
        }
      }
      break;
    }
  }
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
