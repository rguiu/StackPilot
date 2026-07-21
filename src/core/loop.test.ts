import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runTurn, type TurnDeps, type TurnIO } from "./loop.js";
import { SessionStore } from "../session/store.js";
import { createRegistry } from "../tools/index.js";
import type { StreamResult } from "../transport/anthropic.js";

const home = mkdtempSync(join(tmpdir(), "sp-loop-"));
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const silentIO = (permit: TurnIO["permit"]): TurnIO => ({
  onText: () => {},
  onToolStart: () => {},
  onToolEnd: () => {},
  permit,
});

const config = {
  baseUrl: "http://unused",
  apiKey: "test",
  model: "test-model",
  maxTokens: 100,
};

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

function toolUseResponse(): StreamResult {
  return {
    content: [
      { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
    ],
    stopReason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 5 },
    model: "test-model",
  };
}

function textResponse(text: string): StreamResult {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
    model: "test-model",
  };
}

describe("runTurn tool_use/tool_result invariant", () => {
  it("backfills a synthetic tool_result when the permission prompt aborts", async () => {
    const store = SessionStore.create("/fake/cwd", home);
    const deps: TurnDeps = {
      cwd: "/fake/cwd",
      store,
      registry: createRegistry(),
      config,
      system: "test",
      io: silentIO(() => Promise.reject(abortError())),
      stream: async () => toolUseResponse(),
    };

    await expect(runTurn(deps, "do something")).rejects.toThrow("aborted");

    const events = store.all();
    const last = events[events.length - 1]!;
    expect(last.type).toBe("user");
    const content = last.message!.content as {
      type: string;
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    }[];
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe("tool_result");
    expect(content[0]!.tool_use_id).toBe("tu_1");
    expect(content[0]!.content).toContain("interrupted");
    expect(content[0]!.is_error).toBe(true);
  });

  it("pairs every stored tool_use with a tool_result on the happy path", async () => {
    const store = SessionStore.create("/fake/cwd", home);
    let call = 0;
    const deps: TurnDeps = {
      cwd: "/fake/cwd",
      store,
      registry: createRegistry(),
      config,
      system: "test",
      io: silentIO(() => Promise.resolve({ allowed: false })), // deny → still produces a result
      stream: async () =>
        call++ === 0 ? toolUseResponse() : textResponse("done"),
    };

    await runTurn(deps, "do something");

    const uses: string[] = [];
    const resultsFor: string[] = [];
    for (const e of store.all()) {
      const content = e.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as {
        type: string;
        id?: string;
        tool_use_id?: string;
      }[]) {
        if (block.type === "tool_use" && block.id) uses.push(block.id);
        if (block.type === "tool_result" && block.tool_use_id)
          resultsFor.push(block.tool_use_id);
      }
    }
    expect(uses).toHaveLength(1);
    expect(resultsFor).toEqual(uses);
  });

  it("auto-compacts mid-turn when the stack crosses the token threshold", async () => {
    const store = SessionStore.create("/fake/cwd", home);
    const registry = createRegistry();
    registry.setEnabled(["Read"]); // avoid running a real shell command
    let call = 0;
    const deps: TurnDeps = {
      cwd: "/fake/cwd",
      store,
      registry,
      config,
      system: "test",
      autoCompactAtTokens: 1000,
      io: silentIO(() => Promise.resolve({ allowed: false })),
      stream: async () => {
        // 1st: model calls a tool with a huge input_tokens (crosses threshold).
        // The between-iteration maybeCompact then issues a compaction request.
        // 2nd (compaction): return the summary text.
        // 3rd: model ends the turn.
        if (call++ === 0) {
          return {
            content: [
              {
                type: "tool_use",
                id: "tu_1",
                name: "Read",
                input: { file_path: "/fake/cwd/x" },
              },
            ],
            stopReason: "tool_use",
            usage: { input_tokens: 2000, output_tokens: 5 },
            model: "test-model",
          };
        }
        if (call === 2) return textResponse("## Goal\nsummary");
        return textResponse("done");
      },
    };

    const stats = await runTurn(deps, "do something");

    const summaries = store.all().filter((e) => e.isCompactSummary === true);
    expect(summaries).toHaveLength(1);
    expect(stats.notes.some((n) => n.includes("auto-compacted"))).toBe(true);
  });

  it("does not compact when lastRequestInputTokens stays below the threshold", async () => {
    const store = SessionStore.create("/fake/cwd", home);
    const registry = createRegistry();
    registry.setEnabled(["Read"]);
    let call = 0;
    const deps: TurnDeps = {
      cwd: "/fake/cwd",
      store,
      registry,
      config,
      system: "test",
      autoCompactAtTokens: 1_000_000,
      io: silentIO(() => Promise.resolve({ allowed: false })),
      stream: async () => {
        if (call++ === 0) {
          return {
            content: [
              {
                type: "tool_use",
                id: "tu_1",
                name: "Read",
                input: { file_path: "/fake/cwd/x" },
              },
            ],
            stopReason: "tool_use",
            usage: { input_tokens: 10, output_tokens: 5 },
            model: "test-model",
          };
        }
        return textResponse("done");
      },
    };

    await runTurn(deps, "do something");

    const summaries = store.all().filter((e) => e.isCompactSummary === true);
    expect(summaries).toHaveLength(0);
  });

  it("rejects a disabled tool without consulting the permission gate", async () => {
    const store = SessionStore.create("/fake/cwd", home);
    const registry = createRegistry();
    registry.setEnabled(["Read"]); // Bash not enabled
    let permitCalled = false;
    let call = 0;
    const deps: TurnDeps = {
      cwd: "/fake/cwd",
      store,
      registry,
      config,
      system: "test",
      io: silentIO(() => {
        permitCalled = true;
        return Promise.resolve({ allowed: true });
      }),
      stream: async () =>
        call++ === 0 ? toolUseResponse() : textResponse("done"),
    };

    await runTurn(deps, "do something");

    expect(permitCalled).toBe(false);
    const all = JSON.stringify(store.all());
    expect(all).toContain("tool disabled for this session: Bash");
  });
});
