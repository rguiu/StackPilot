import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyCacheControl,
  CacheLedger,
  diffFingerprints,
  prefixFingerprint,
  stripCacheControl,
} from "./cache.js";
import { runTurn, type TurnDeps, type TurnIO } from "./loop.js";
import { SessionStore } from "../session/store.js";
import { createRegistry } from "../tools/index.js";
import type { MessagesRequest, StreamResult } from "../transport/anthropic.js";

const home = mkdtempSync(join(tmpdir(), "sp-cache-"));
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const msg = (
  role: "user" | "assistant",
  text: string,
): { role: "user" | "assistant"; content: unknown } => ({
  role,
  content: [{ type: "text", text }],
});

describe("applyCacheControl", () => {
  it("marks the system block (static breakpoint)", () => {
    const req = applyCacheControl("SYS", [], [msg("user", "hi")]);
    expect(req.system).toEqual([
      { type: "text", text: "SYS", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("marks only the last block of the last message (moving breakpoint)", () => {
    const req = applyCacheControl(
      "SYS",
      [],
      [msg("user", "one"), msg("assistant", "two"), msg("user", "three")],
    );
    expect(JSON.stringify(req.messages[0])).not.toContain("cache_control");
    expect(JSON.stringify(req.messages[1])).not.toContain("cache_control");
    const last = req.messages[2]!.content as Record<string, unknown>[];
    expect(last[last.length - 1]!.cache_control).toEqual({
      type: "ephemeral",
    });
  });

  it("converts string content so it can carry the marker", () => {
    const req = applyCacheControl(
      "SYS",
      [],
      [{ role: "user", content: "plain" }],
    );
    expect(req.messages[0]!.content).toEqual([
      { type: "text", text: "plain", cache_control: { type: "ephemeral" } },
    ]);
  });
});

describe("stripCacheControl", () => {
  it("removes every marker, deep", () => {
    const req = applyCacheControl("SYS", [], [msg("user", "hi")]);
    expect(JSON.stringify(stripCacheControl(req))).not.toContain(
      "cache_control",
    );
  });
});

describe("fingerprints", () => {
  const tools = [{ name: "Read" }];

  it("pure append does not diverge, even as the marker moves", () => {
    const a = applyCacheControl("SYS", tools, [msg("user", "one")]);
    const b = applyCacheControl("SYS", tools, [
      msg("user", "one"),
      msg("assistant", "two"),
    ]);
    const diff = diffFingerprints(prefixFingerprint(a), prefixFingerprint(b));
    expect(diff.divergedAt).toBeNull();
    expect(diff.invalidatedApproxTokens).toBe(0);
  });

  it("detects a mutated message and reports the suffix cost", () => {
    const a = applyCacheControl("SYS", tools, [
      msg("user", "one"),
      msg("assistant", "two"),
    ]);
    const b = applyCacheControl("SYS", tools, [
      msg("user", "CHANGED"),
      msg("assistant", "two"),
    ]);
    const diff = diffFingerprints(prefixFingerprint(a), prefixFingerprint(b));
    expect(diff.divergedAt).toBe(0);
    expect(diff.staticChanged).toBe(false);
    expect(diff.invalidatedApproxTokens).toBeGreaterThan(0);
  });

  it("detects a changed static prefix", () => {
    const a = applyCacheControl("SYS", tools, [msg("user", "one")]);
    const b = applyCacheControl("OTHER", tools, [msg("user", "one")]);
    const diff = diffFingerprints(prefixFingerprint(a), prefixFingerprint(b));
    expect(diff.staticChanged).toBe(true);
    expect(diff.divergedAt).toBe(0);
  });
});

describe("CacheLedger verdicts", () => {
  const tools = [{ name: "Read" }];
  const reqWith = (texts: string[]): MessagesRequest =>
    applyCacheControl(
      "SYS",
      tools,
      texts.map((t, i) => msg(i % 2 === 0 ? "user" : "assistant", t)),
    );

  it("first request → first", () => {
    const ledger = new CacheLedger();
    ledger.beforeRequest(reqWith(["one"]));
    expect(ledger.afterResponse({}).kind).toBe("first");
  });

  it("append + server reads → hit", () => {
    const ledger = new CacheLedger();
    ledger.beforeRequest(reqWith(["one"]));
    ledger.afterResponse({ cache_creation_input_tokens: 100 });
    ledger.beforeRequest(reqWith(["one", "two"]));
    const verdict = ledger.afterResponse({
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 10,
    });
    expect(verdict.kind).toBe("hit");
    expect(verdict.note).toBeNull();
  });

  it("mutated history → predicted-regen with the diverged index", () => {
    const ledger = new CacheLedger();
    ledger.beforeRequest(reqWith(["one", "two"]));
    ledger.afterResponse({});
    ledger.beforeRequest(reqWith(["CHANGED", "two"]));
    const verdict = ledger.afterResponse({
      cache_creation_input_tokens: 500,
    });
    expect(verdict.kind).toBe("predicted-regen");
    expect(verdict.note).toContain("message[0]");
  });

  it("stable prefix but server wrote → unexpected-regen", () => {
    const ledger = new CacheLedger();
    ledger.beforeRequest(reqWith(["one"]));
    ledger.afterResponse({});
    ledger.beforeRequest(reqWith(["one", "two"]));
    const verdict = ledger.afterResponse({
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 321,
    });
    expect(verdict.kind).toBe("unexpected-regen");
    expect(verdict.note).toContain("321");
  });
});

describe("two-turn byte-stable prefix invariant (through runTurn)", () => {
  it("turn N's request is a marker-stripped byte prefix of turn N+1's", async () => {
    const store = SessionStore.create("/fake/cwd", home);
    const captured: MessagesRequest[] = [];
    const io: TurnIO = {
      onText: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      permit: () => Promise.resolve({ allowed: true }),
    };
    const deps: TurnDeps = {
      cwd: "/fake/cwd",
      store,
      registry: createRegistry(),
      config: { baseUrl: "http://x", apiKey: "k", model: "m", maxTokens: 10 },
      system: "SYS",
      io,
      stream: async (_cfg, req): Promise<StreamResult> => {
        captured.push(req);
        return {
          content: [{ type: "text", text: "ok" }],
          stopReason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
          model: "m",
        };
      },
    };

    await runTurn(deps, "first question");
    await runTurn(deps, "second question");

    expect(captured).toHaveLength(2);
    const [a, b] = captured.map((r) => stripCacheControl(r));

    // Static part byte-identical.
    expect(JSON.stringify({ s: a!.system, t: a!.tools })).toBe(
      JSON.stringify({ s: b!.system, t: b!.tools }),
    );
    // Earlier messages are untouched by the later turn…
    expect(b!.messages.slice(0, a!.messages.length)).toEqual(a!.messages);
    // …down to the serialized bytes (drop the closing bracket).
    const aJson = JSON.stringify(a!.messages);
    const bJson = JSON.stringify(b!.messages);
    expect(bJson.startsWith(aJson.slice(0, -1))).toBe(true);
  });
});
