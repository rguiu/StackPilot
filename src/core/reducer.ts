// Pure event-tree reducer: events → active path → API messages.
//
// Semantics match aap's claude-transcript analysis (and therefore Claude
// Code's transcripts): the file is an append-only TREE via parentUuid → uuid;
// rewind writes a new event whose parent is an earlier node. The active
// conversation is the chain from the newest chained event (last uuid line in
// file order) back to the root. Events without a uuid are pure metadata.

import type { ApiMessage, SessionEvent } from "../session/events.js";

export interface TreeStats {
  totalEvents: number;
  chainedEvents: number;
  activePathEvents: number;
  abandonedEvents: number;
  leafCount: number;
  branchPoints: number;
}

export interface ReducedSession {
  stats: TreeStats;
  activePath: readonly SessionEvent[];
  // uuid of the active leaf — the parent for the next appended event.
  leafUuid: string | null;
  // API-visible conversation (user/assistant events carrying a message).
  messages: readonly ApiMessage[];
}

export function activePath(
  events: readonly SessionEvent[],
): readonly SessionEvent[] {
  const byUuid = new Map<string, SessionEvent>();
  for (const e of events) {
    if (e.uuid) byUuid.set(e.uuid, e);
  }
  if (byUuid.size === 0) return [];

  let leaf: string | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.uuid) {
      leaf = event.uuid;
      break;
    }
  }

  const reversed: SessionEvent[] = [];
  const seen = new Set<string>();
  let cur: string | null | undefined = leaf;
  while (cur && byUuid.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    const node = byUuid.get(cur);
    if (!node) break;
    reversed.push(node);
    cur = node.parentUuid ?? null;
  }
  return reversed.reverse();
}

export function reduce(events: readonly SessionEvent[]): ReducedSession {
  const parents = new Set<string | null | undefined>();
  const childCounts = new Map<string | null | undefined, number>();
  for (const e of events) {
    parents.add(e.parentUuid);
    childCounts.set(e.parentUuid, (childCounts.get(e.parentUuid) ?? 0) + 1);
  }

  const chained = events.filter((e) => e.uuid);
  const leafCount = chained.filter((e) => !parents.has(e.uuid)).length;
  let branchPoints = 0;
  for (const [, count] of childCounts) if (count > 1) branchPoints++;

  const path = activePath(events);
  const messages: ApiMessage[] = [];
  for (const e of path) {
    if ((e.type === "user" || e.type === "assistant") && e.message) {
      // A compact summary supersedes everything before it: the API-visible
      // conversation restarts at the summary (older events stay on disk).
      if (e.isCompactSummary === true) messages.length = 0;
      messages.push({
        role: e.message.role,
        content: e.message.content,
        usage: e.message.usage,
      });
    }
  }

  return {
    stats: {
      totalEvents: events.length,
      chainedEvents: chained.length,
      activePathEvents: path.length,
      abandonedEvents: chained.length - path.length,
      leafCount,
      branchPoints,
    },
    activePath: path,
    leafUuid: path.length > 0 ? (path[path.length - 1]?.uuid ?? null) : null,
    messages,
  };
}

// Strip usage before sending to the API (usage is a local record, not input).
export function toApiMessages(
  messages: readonly ApiMessage[],
): { role: "user" | "assistant"; content: unknown }[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}
