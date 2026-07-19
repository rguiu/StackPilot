import { describe, expect, it } from "vitest";
import {
  pageToolResults,
  deduplicateReadResult,
  evictOldResults,
  turnsExceeded,
  type SessionState,
} from "./policies.js";
import type { ContentBlock } from "../types.js";

function makeState(): SessionState {
  return {
    pagedOutputs: new Map(),
    readCache: new Map(),
  };
}

type Message = { role: "user" | "assistant"; content: ContentBlock[] };

describe("pageToolResults", () => {
  it("leaves short tool_results unchanged", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "short" },
        ],
      },
    ];
    const state = makeState();
    const out = pageToolResults(msgs, state);
    const b = out[0]!.content[0] as { content: string };
    expect(b.content).toBe("short");
  });

  it("truncates long tool_results and stores in pagedOutputs", () => {
    const long = "x".repeat(15_000);
    const msgs: Message[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: long }],
      },
    ];
    const state = makeState();
    const out = pageToolResults(msgs, state, 5_000);

    const b = out[0]!.content[0] as { content: string };
    expect(b.content).not.toBe(long);
    expect(b.content.length).toBeLessThan(long.length);
    expect(state.pagedOutputs.get("tu_1")).toBe(long);
  });

  it("does not mutate original messages", () => {
    const long = "x".repeat(15_000);
    const msgs: Message[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: long }],
      },
    ];
    const state = makeState();
    pageToolResults(msgs, state, 5_000);
    const b = msgs[0]!.content[0] as { content: string };
    expect(b.content).toBe(long);
  });

  it("skips tool_results below maxChars", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
      },
    ];
    const state = makeState();
    pageToolResults(msgs, state, 100);
    expect(state.pagedOutputs.has("tu_1")).toBe(false);
  });

  it("skips assistant messages", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "x".repeat(200),
          },
        ],
      },
    ];
    const state = makeState();
    const out = pageToolResults(msgs, state, 100);
    const b = out[0]!.content[0] as { content: string };
    expect(b.content).toBe("x".repeat(200));
  });

  it("handles empty messages array", () => {
    const state = makeState();
    const out = pageToolResults([], state);
    expect(out).toEqual([]);
  });
});

describe("deduplicateReadResult", () => {
  it("returns full content on first read", () => {
    const state = makeState();
    const result = deduplicateReadResult("foo.ts", "file content", state);
    expect(result).toBe("file content");
    expect(state.readCache.has("foo.ts")).toBe(true);
  });

  it("returns unchanged marker on identical second read", () => {
    const state = makeState();
    deduplicateReadResult("foo.ts", "file content", state);
    const result = deduplicateReadResult("foo.ts", "file content", state);
    expect(result).toContain("unchanged from previous read");
  });

  it("returns full content on changed read", () => {
    const state = makeState();
    deduplicateReadResult("foo.ts", "v1", state);
    const result = deduplicateReadResult("foo.ts", "v2 changed", state);
    expect(result).toBe("v2 changed");
    expect(state.readCache.get("foo.ts")?.content).toBe("v2 changed");
  });
});

describe("evictOldResults", () => {
  it("leaves recent results intact", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [{ type: "tool_result", content: "keep", tool_use_id: "x" }],
      },
    ];
    const out = evictOldResults(msgs, 5);
    const b = out[0]!.content[0] as { content: string };
    expect(b.content).toBe("keep");
  });

  it("does not mutate input messages", () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 10; i++) {
      msgs.push({
        role: "assistant",
        content: [{ type: "text", text: `turn ${i}` }],
      });
      msgs.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `t${i}`,
            content: `result ${i}`,
          },
        ],
      });
    }
    evictOldResults(msgs, 3);
    for (let i = 0; i < 10; i++) {
      const b = msgs[i * 2 + 1]!.content[0] as { content: string };
      expect(b.content).toBe(`result ${i}`);
    }
  });

  it("evicts tool_results beyond the keep window", () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 10; i++) {
      msgs.push({
        role: "assistant",
        content: [{ type: "text", text: `turn ${i}` }],
      });
      msgs.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `t${i}`,
            content: `result ${i}`,
          },
        ],
      });
    }
    const out = evictOldResults(msgs, 3);

    for (let i = 0; i < 10; i++) {
      const b = out[i * 2 + 1]!.content[0] as { content: string };
      if (i < 10 - 3) {
        expect(b.content).toBe("[evicted]");
      } else {
        expect(b.content).toBe(`result ${i}`);
      }
    }
  });

  it("handles empty messages array", () => {
    const out = evictOldResults([]);
    expect(out).toEqual([]);
  });
});

describe("turnsExceeded", () => {
  it("returns false when under threshold", () => {
    const msgs: Message[] = [
      { role: "user", content: [] },
      { role: "assistant", content: [] },
      { role: "user", content: [] },
    ];
    expect(turnsExceeded(msgs, 5)).toBe(false);
  });

  it("returns true when over threshold", () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: "assistant", content: [] });
      msgs.push({ role: "user", content: [] });
    }
    expect(turnsExceeded(msgs, 5)).toBe(true);
  });

  it("returns false when exactly at threshold", () => {
    const msgs: Message[] = [];
    for (let i = 0; i < 3; i++) {
      msgs.push({ role: "assistant", content: [] });
      msgs.push({ role: "user", content: [] });
    }
    expect(turnsExceeded(msgs, 3)).toBe(false);
  });
});
