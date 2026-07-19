import { describe, expect, it } from "vitest";
import {
  toolUses,
  textOf,
  accumulateUsage,
  firstTextBlock,
} from "./message.js";
import type { ContentBlock } from "../types.js";
import type { UsageInfo } from "../transport/anthropic.js";

describe("toolUses", () => {
  it("filters tool_use blocks from mixed content", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "hello" },
      { type: "tool_use", id: "tu_1", name: "Read", input: {} },
      { type: "text", text: "world" },
      { type: "tool_use", id: "tu_2", name: "Bash", input: {} },
    ];
    const result = toolUses(content);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("tu_1");
    expect(result[1]!.id).toBe("tu_2");
  });

  it("returns empty array for text-only content", () => {
    const content: ContentBlock[] = [{ type: "text", text: "just text" }];
    expect(toolUses(content)).toEqual([]);
  });

  it("returns empty array for empty content", () => {
    expect(toolUses([])).toEqual([]);
  });

  it("skips tool_result blocks", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "a" },
      {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "result",
      },
    ];
    expect(toolUses(content)).toEqual([]);
  });
});

describe("textOf", () => {
  it("concatenates text blocks", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "hello " },
      { type: "tool_use", id: "1", name: "X", input: {} },
      { type: "text", text: "world" },
    ];
    expect(textOf(content)).toBe("hello world");
  });

  it("returns empty string for no text blocks", () => {
    const content: ContentBlock[] = [
      { type: "tool_use", id: "1", name: "X", input: {} },
    ];
    expect(textOf(content)).toBe("");
  });

  it("returns empty string for empty content", () => {
    expect(textOf([])).toBe("");
  });
});

describe("accumulateUsage", () => {
  it("adds all usage fields to accumulator", () => {
    const acc = {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
    };
    const usage: UsageInfo = {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 10,
    };
    accumulateUsage(acc, usage);
    expect(acc.input_tokens).toBe(110);
    expect(acc.output_tokens).toBe(55);
    expect(acc.cache_read_input_tokens).toBe(22);
    expect(acc.cache_creation_input_tokens).toBe(11);
  });

  it("handles undefined usage fields with ?? 0", () => {
    const acc = {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    accumulateUsage(acc, {});
    expect(acc.input_tokens).toBe(0);
  });
});

describe("firstTextBlock", () => {
  it("returns trimmed string input directly", () => {
    expect(firstTextBlock("  hello world  ")).toBe("hello world");
  });

  it("returns null for empty string", () => {
    expect(firstTextBlock("   ")).toBe(null);
  });

  it("finds first non-empty text block in an array", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "   " },
      { type: "tool_use", id: "1", name: "X", input: {} },
      { type: "text", text: "  actual text  " },
    ];
    expect(firstTextBlock(content)).toBe("actual text");
  });

  it("returns null for array with only empty text blocks", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "  " },
      { type: "text", text: "" },
    ];
    expect(firstTextBlock(content)).toBe(null);
  });

  it("returns null for non-string non-array", () => {
    expect(firstTextBlock(42)).toBe(null);
    expect(firstTextBlock(null)).toBe(null);
  });
});
