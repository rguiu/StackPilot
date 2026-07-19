import type { ToolUseBlock, ContentBlock, TextBlock } from "../types.js";
import type { UsageInfo } from "../transport/anthropic.js";

export function toolUses(content: ContentBlock[]): ToolUseBlock[] {
  return content.filter((b): b is ToolUseBlock => b.type === "tool_use");
}

export function textOf(content: ContentBlock[]): string {
  return content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

export function accumulateUsage(
  acc: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  },
  usage: UsageInfo,
): void {
  acc.input_tokens += usage.input_tokens ?? 0;
  acc.output_tokens += usage.output_tokens ?? 0;
  acc.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
  acc.cache_creation_input_tokens += usage.cache_creation_input_tokens ?? 0;
}

export function firstTextBlock(content: unknown): string | null {
  if (typeof content === "string" && content.trim()) return content.trim();
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    if ((block as { type?: unknown }).type !== "text") continue;
    const text = (block as TextBlock).text.trim();
    if (text) return text;
  }
  return null;
}
