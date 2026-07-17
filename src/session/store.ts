// Session persistence: append-only JSONL, one file per session, laid out like
// Claude Code's (~/.stackpilot/projects/<cwd-slug>/<session-uuid>.jsonl).
// All I/O lives here; tree logic is in core/reducer.ts (pure).

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import {
  assertWritable,
  parseEventLines,
  type SessionEvent,
} from "./events.js";

export function projectSlug(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

export function projectsDir(home: string = homedir()): string {
  return join(home, ".stackpilot", "projects");
}

export interface SessionSummary {
  path: string;
  id: string;
  mtimeMs: number;
  preview: string | null;
}

// First user prompt text in a session (Claude transcripts use both string
// and block-array content; tool_result-only user events are skipped).
export function firstUserText(events: readonly SessionEvent[]): string | null {
  for (const e of events) {
    if (e.type !== "user" || !e.message) continue;
    const content = e.message.content;
    if (typeof content === "string" && content.trim()) return content.trim();
    if (!Array.isArray(content)) continue;
    for (const block of content as { type?: string; text?: string }[]) {
      if (block.type === "text" && block.text?.trim()) {
        return block.text.trim();
      }
    }
  }
  return null;
}

export class SessionStore {
  readonly sessionId: string;
  readonly path: string;
  private events: SessionEvent[];

  private constructor(path: string, sessionId: string, events: SessionEvent[]) {
    this.path = path;
    this.sessionId = sessionId;
    this.events = events;
  }

  static create(cwd: string, home?: string): SessionStore {
    const id = randomUUID();
    const dir = join(projectsDir(home), projectSlug(cwd));
    mkdirSync(dir, { recursive: true });
    return new SessionStore(join(dir, `${id}.jsonl`), id, []);
  }

  static open(path: string): SessionStore {
    const events = parseEventLines(readFileSync(path, "utf8"));
    return new SessionStore(path, basename(path, ".jsonl"), events);
  }

  // Newest session file for a cwd, or null.
  static newestFor(cwd: string, home?: string): string | null {
    const newest = SessionStore.summariesFor(cwd, home)[0];
    return newest?.path ?? null;
  }

  // All sessions for a cwd, newest first, with a preview of the first user
  // prompt (for resume pickers).
  static summariesFor(cwd: string, home?: string): SessionSummary[] {
    const dir = join(projectsDir(home), projectSlug(cwd));
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    const out: SessionSummary[] = [];
    for (const e of entries) {
      if (!e.endsWith(".jsonl")) continue;
      const path = join(dir, e);
      let mtimeMs: number;
      let events: SessionEvent[];
      try {
        mtimeMs = statSync(path).mtimeMs;
        events = parseEventLines(readFileSync(path, "utf8"));
      } catch {
        continue; // unreadable session file — skip, don't crash the picker
      }
      out.push({
        path,
        id: basename(e, ".jsonl"),
        mtimeMs,
        preview: firstUserText(events),
      });
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  all(): readonly SessionEvent[] {
    return this.events;
  }

  // Append is the only mutation. parentUuid is explicit — passing it wrong
  // corrupts the tree, so no defaults. Returns the stored event (with uuid).
  append(event: {
    type: string;
    parentUuid: string | null;
    message?: SessionEvent["message"];
  }): SessionEvent {
    const full: SessionEvent = {
      ...event,
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
    };
    assertWritable(full);
    appendFileSync(this.path, JSON.stringify(full) + "\n", "utf8");
    this.events.push(full);
    return full;
  }
}
