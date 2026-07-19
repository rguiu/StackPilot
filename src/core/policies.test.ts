import { describe, expect, it } from "vitest";
import {
  pageToolResults,
  deduplicateReads,
  evictOldResults,
  type SessionState,
} from "./policies.js";

function makeState(): SessionState {
  return {
    pagedOutputs: new Map(),
    readCache: new Map(),
  };
}

type Message = { role: "user" | "assistant"; content: unknown };

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
    pageToolResults(msgs, state);
    const b = (msgs[0]!.content as Record<string, unknown>[])[0]!;
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
    pageToolResults(msgs, state, 5_000);

    const b = (msgs[0]!.content as Record<string, unknown>[])[0]!;
    expect(b.content).not.toBe(long);
    expect((b.content as string).length).toBeLessThan(long.length);
    expect(state.pagedOutputs.get("tu_1")).toBe(long);
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
    pageToolResults(msgs, state, 100);
    const b = (msgs[0]!.content as Record<string, unknown>[])[0]!;
    expect(b.content).toBe("x".repeat(200));
  });

  it("handles empty messages array", () => {
    const state = makeState();
    pageToolResults([], state);
  });
});

describe("deduplicateReads", () => {
  it("caches a first read", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "Read",
            input: { file_path: "foo.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "file content",
          },
        ],
      },
    ];
    const state = makeState();
    deduplicateReads(msgs, state);
    expect(state.readCache.has("foo.ts")).toBe(true);
    const b = (msgs[1]!.content as Record<string, unknown>[])[0]!;
    expect(b.content).toBe("file content");
  });

  it("replaces an unchanged second read with a summary", () => {
    const content = "file content v1";
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "Read",
            input: { file_path: "foo.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_2",
            name: "Read",
            input: { file_path: "foo.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_2", content }],
      },
    ];
    const state = makeState();
    deduplicateReads(msgs, state);
    const b = (msgs[3]!.content as Record<string, unknown>[])[0]!;
    expect(b.content).toContain("unchanged from previous read");
  });

  it("keeps a changed read", () => {
    const msgs: Message[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "Read",
            input: { file_path: "foo.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "v1" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_2",
            name: "Read",
            input: { file_path: "foo.ts" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_2", content: "v2 changed" },
        ],
      },
    ];
    const state = makeState();
    deduplicateReads(msgs, state);
    const b = (msgs[3]!.content as Record<string, unknown>[])[0]!;
    expect(b.content).toBe("v2 changed");
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
    evictOldResults(msgs, 5);
    const b = (msgs[0]!.content as Record<string, unknown>[])[0]!;
    expect(b.content).toBe("keep");
  });

  it("evicts tool_results beyond the keep window", () => {
    const msgs: Message[] = [];
    // Build many turns: each turn = assistant + user message.
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

    // Last 3 turns (indices 14-19) should be intact.
    for (let i = 0; i < 10; i++) {
      const userMsg = msgs[i * 2 + 1]!;
      const b = (userMsg.content as Record<string, unknown>[])[0]!;
      if (i < 10 - 3) {
        expect(b.content).toBe("[evicted]");
      } else {
        expect(b.content).toBe(`result ${i}`);
      }
    }
  });

  it("handles empty messages array", () => {
    evictOldResults([]);
  });
});
