import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEventLines, type SessionEvent } from "../session/events.js";
import { reduce } from "./reducer.js";

const FIXTURE = join(
  import.meta.dirname,
  "../../fixtures/transcripts/rewind-session.jsonl",
);

describe("reduce on the recorded Claude Code rewind session", () => {
  const events = parseEventLines(readFileSync(FIXTURE, "utf8"));
  const result = reduce(events);

  it("reproduces the reference tree numbers exactly", () => {
    expect(result.stats.totalEvents).toBe(51);
    expect(result.stats.activePathEvents).toBe(25);
    expect(result.stats.abandonedEvents).toBe(6);
    expect(result.stats.leafCount).toBe(2);
    expect(result.stats.branchPoints).toBe(2);
  });

  it("reconstructs the API-visible conversation", () => {
    expect(result.messages.length).toBe(19);
    expect(result.messages[0]!.role).toBe("user");
    for (const m of result.messages) {
      expect(["user", "assistant"]).toContain(m.role);
    }
  });

  it("follows the rewound branch, not the abandoned one", () => {
    const text = JSON.stringify(result.messages);
    expect(text).toContain("safeDivide");
  });
});

describe("reduce on synthetic trees", () => {
  const ev = (
    uuid: string,
    parentUuid: string | null,
    type = "user",
  ): SessionEvent => ({
    type,
    uuid,
    parentUuid,
    message: { role: "user", content: uuid },
  });

  it("handles the empty session", () => {
    const r = reduce([]);
    expect(r.stats.totalEvents).toBe(0);
    expect(r.leafUuid).toBeNull();
    expect(r.messages).toEqual([]);
  });

  it("walks a linear chain", () => {
    const r = reduce([ev("a", null), ev("b", "a"), ev("c", "b")]);
    expect(r.stats.activePathEvents).toBe(3);
    expect(r.stats.leafCount).toBe(1);
    expect(r.stats.branchPoints).toBe(0);
    expect(r.leafUuid).toBe("c");
  });

  it("abandons the old branch after a rewind", () => {
    // a → b → c, then rewind to a and continue with d (appended last).
    const r = reduce([ev("a", null), ev("b", "a"), ev("c", "b"), ev("d", "a")]);
    expect(r.stats.activePathEvents).toBe(2); // a, d
    expect(r.stats.abandonedEvents).toBe(2); // b, c
    expect(r.stats.leafCount).toBe(2);
    expect(r.stats.branchPoints).toBe(1);
    expect(r.leafUuid).toBe("d");
    expect(r.messages.map((m) => m.content)).toEqual(["a", "d"]);
  });

  it("ignores uuid-less metadata events for pathing", () => {
    const meta: SessionEvent = { type: "meta", parentUuid: null };
    const r = reduce([ev("a", null), meta, ev("b", "a")]);
    expect(r.stats.totalEvents).toBe(3);
    expect(r.stats.chainedEvents).toBe(2);
    expect(r.stats.activePathEvents).toBe(2);
  });

  it("restarts messages at a compact summary", () => {
    const summary: SessionEvent = {
      ...ev("s", "b"),
      isCompactSummary: true,
      message: { role: "user", content: "SUMMARY" },
    };
    const r = reduce([ev("a", null), ev("b", "a"), summary, ev("c", "s")]);
    expect(r.stats.activePathEvents).toBe(4); // tree unaffected
    expect(r.messages.map((m) => m.content)).toEqual(["SUMMARY", "c"]);
  });

  it("uses only the LAST compact summary", () => {
    const s1: SessionEvent = {
      ...ev("s1", "a"),
      isCompactSummary: true,
      message: { role: "user", content: "FIRST" },
    };
    const s2: SessionEvent = {
      ...ev("s2", "s1"),
      isCompactSummary: true,
      message: { role: "user", content: "SECOND" },
    };
    const r = reduce([ev("a", null), s1, s2, ev("z", "s2")]);
    expect(r.messages.map((m) => m.content)).toEqual(["SECOND", "z"]);
  });
});
