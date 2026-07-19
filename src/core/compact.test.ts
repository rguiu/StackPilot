import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildCompactRequest,
  COMPACT_INSTRUCTION,
  runCompact,
} from "./compact.js";
import { reduce } from "./reducer.js";
import { SessionStore } from "../session/store.js";
import { createRegistry } from "../tools/index.js";
import type { StreamResult } from "../transport/anthropic.js";

const home = mkdtempSync(join(tmpdir(), "sp-compact-"));
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const config = {
  baseUrl: "http://x",
  apiKey: "k",
  model: "m",
  maxTokens: 10,
};

function summaryResponse(text: string): StreamResult {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: {
      input_tokens: 5,
      output_tokens: 50,
      cache_read_input_tokens: 1000,
    },
    model: "m",
  };
}

function seedConversation(store: SessionStore): void {
  const u = store.append({
    type: "user",
    parentUuid: null,
    message: { role: "user", content: [{ type: "text", text: "fix the bug" }] },
  });
  store.append({
    type: "assistant",
    parentUuid: u.uuid!,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    },
  });
}

describe("buildCompactRequest", () => {
  it("appends the instruction as the last user message, tools included", () => {
    const req = buildCompactRequest(
      "SYS",
      [{ name: "Read" }],
      [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    );
    expect(req.tools).toHaveLength(1); // prefix reuse — never dropped
    expect(req.messages).toHaveLength(2);
    const last = req.messages[1]!;
    expect(last.role).toBe("user");
    const block = (last.content as Record<string, unknown>[])[0]!;
    expect(block.text).toBe(COMPACT_INSTRUCTION);
    expect(block.cache_control).toEqual({ type: "ephemeral" });
  });
});

describe("runCompact", () => {
  it("returns null on an empty session", async () => {
    const store = SessionStore.create("/fake", home);
    const result = await runCompact({
      store,
      registry: createRegistry(),
      config,
      system: "SYS",
      stream: async () => summaryResponse("s"),
    });
    expect(result).toBeNull();
    expect(store.all()).toHaveLength(0);
  });

  it("appends a summary event and the reducer restarts from it", async () => {
    const store = SessionStore.create("/fake", home);
    seedConversation(store);
    const before = reduce(store.all());
    expect(before.messages).toHaveLength(2);

    const result = await runCompact({
      store,
      registry: createRegistry(),
      config,
      system: "SYS",
      pricing: { m: { inputPerMTok: 1, outputPerMTok: 5 } },
      stream: async () => summaryResponse("## Goal\nfix the bug"),
    });

    expect(result).not.toBeNull();
    expect(result!.totalMessages).toBe(2);
    expect(result!.costUsd).toBeGreaterThan(0);

    const after = reduce(store.all());
    expect(after.messages).toHaveLength(1);
    expect(JSON.stringify(after.messages[0]!.content)).toContain("## Goal");
    // Tree still append-only: all prior events remain on disk.
    expect(store.all()).toHaveLength(3);
    const last = store.all()[2]!;
    expect(last.isCompactSummary).toBe(true);
    expect(last.parentUuid).toBe(before.leafUuid);
  });

  it("conversation continues on top of the summary", async () => {
    const store = SessionStore.create("/fake", home);
    seedConversation(store);
    await runCompact({
      store,
      registry: createRegistry(),
      config,
      system: "SYS",
      stream: async () => summaryResponse("SUMMARY"),
    });
    const leaf = reduce(store.all()).leafUuid;
    store.append({
      type: "user",
      parentUuid: leaf,
      message: { role: "user", content: [{ type: "text", text: "next task" }] },
    });
    const messages = reduce(store.all()).messages;
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages[0]!.content)).toContain("SUMMARY");
    expect(JSON.stringify(messages[1]!.content)).toContain("next task");
  });

  it("throws on an empty summary and leaves the tree untouched", async () => {
    const store = SessionStore.create("/fake", home);
    seedConversation(store);
    await expect(
      runCompact({
        store,
        registry: createRegistry(),
        config,
        system: "SYS",
        stream: async () => summaryResponse("   "),
      }),
    ).rejects.toThrow("no summary");
    expect(store.all()).toHaveLength(2);
  });
});
