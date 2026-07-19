import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { firstUserText, SessionStore } from "./store.js";
import type { SessionEvent } from "./events.js";
import type { ContentBlock } from "../types.js";

const home = mkdtempSync(join(tmpdir(), "sp-store-"));
const cwd = "/fake/project";
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

function newSession(prompt: string, mtime: Date): SessionStore {
  const store = SessionStore.create(cwd, home);
  store.append({
    type: "user",
    parentUuid: null,
    message: { role: "user", content: [{ type: "text", text: prompt }] },
  });
  utimesSync(store.path, mtime, mtime);
  return store;
}

describe("SessionStore.summariesFor", () => {
  it("returns [] for an unknown cwd", () => {
    expect(SessionStore.summariesFor("/nowhere", home)).toEqual([]);
  });

  it("lists sessions newest-first with previews", () => {
    const old = newSession("fix the parser", new Date("2026-07-01T10:00:00Z"));
    const recent = newSession("add a TUI", new Date("2026-07-17T10:00:00Z"));

    const summaries = SessionStore.summariesFor(cwd, home);
    expect(summaries.length).toBe(2);
    expect(summaries[0]!.id).toBe(recent.sessionId);
    expect(summaries[0]!.preview).toBe("add a TUI");
    expect(summaries[1]!.id).toBe(old.sessionId);
    expect(summaries[1]!.preview).toBe("fix the parser");
  });
});

describe("firstUserText", () => {
  const user = (content: ContentBlock[]): SessionEvent => ({
    type: "user",
    uuid: "u1",
    parentUuid: null,
    message: { role: "user", content },
  });

  it("reads block-array content", () => {
    expect(firstUserText([user([{ type: "text", text: "hello" }])])).toBe(
      "hello",
    );
  });

  it("reads plain string content (Claude transcripts)", () => {
    const ev: SessionEvent = {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      message: {
        role: "user",
        content: "plain prompt" as unknown as ContentBlock[],
      },
    };
    expect(firstUserText([ev])).toBe("plain prompt");
  });

  it("skips tool_result-only user events", () => {
    const events = [
      user([{ type: "tool_result", tool_use_id: "t1", content: "out" }]),
      user([{ type: "text", text: "actual prompt" }]),
    ];
    expect(firstUserText(events)).toBe("actual prompt");
  });

  it("returns null when there is no user text", () => {
    expect(firstUserText([])).toBeNull();
  });
});
