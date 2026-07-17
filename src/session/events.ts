// Session events — the on-disk unit. Mirrors Claude Code's transcript shape
// (uuid/parentUuid tree, user|assistant events carry an API `message`) so the
// reducer can replay both our sessions and recorded Claude transcripts.

export interface ApiMessage {
  role: "user" | "assistant";
  content: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export interface SessionEvent {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  message?: ApiMessage;
  [key: string]: unknown;
}

export class InvalidEventError extends Error {}

// Fail fast at the persistence boundary: an event we write must be chainable.
export function assertWritable(event: SessionEvent): void {
  if (!event.uuid) throw new InvalidEventError("event.uuid is required");
  if (event.parentUuid === undefined) {
    throw new InvalidEventError("event.parentUuid must be set (null for root)");
  }
  if (event.type === "user" || event.type === "assistant") {
    if (!event.message) {
      throw new InvalidEventError(`${event.type} event requires a message`);
    }
  }
}

// Tolerant read: skip malformed lines (a truncated final write is common
// while a session is live). Never throws on content.
export function parseEventLines(raw: string): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as SessionEvent);
    } catch {
      // skip
    }
  }
  return events;
}
