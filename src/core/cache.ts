// Client side of Anthropic prompt caching.
//
// The cache itself lives on Anthropic's servers; nothing is stored locally.
// What we own is the KEY: byte-stable prefixes plus cache_control markers
// telling the server where reusable prefixes end — and a fingerprint of the
// previous request so we can PREDICT what a stack change will invalidate
// and DETECT regenerations from the usage counters the server returns.
//
// Breakpoint layout (2 of the 4 allowed):
//   1. static  — last system block: covers tools + system, written once
//   2. moving  — last content block of the last message: each turn extends
//      the cached conversation; the server prefix-matches against recent
//      breakpoints, so appending is a hit and mutating history is a miss.

import { createHash } from "node:crypto";
import type { MessagesRequest, UsageInfo } from "../transport/anthropic.js";

type Message = { role: "user" | "assistant"; content: unknown };

const EPHEMERAL = { type: "ephemeral" } as const;

export function applyCacheControl(
  system: string,
  tools: unknown[],
  messages: Message[],
): MessagesRequest {
  const systemBlocks = [
    { type: "text", text: system, cache_control: EPHEMERAL },
  ];

  const marked = messages.map((m, i) =>
    i === messages.length - 1 ? markLastBlock(m) : m,
  );

  return { system: systemBlocks, tools, messages: marked };
}

function markLastBlock(message: Message): Message {
  const { content } = message;
  if (typeof content === "string") {
    return {
      role: message.role,
      content: [{ type: "text", text: content, cache_control: EPHEMERAL }],
    };
  }
  if (Array.isArray(content) && content.length > 0) {
    const blocks = content.slice(0, -1);
    const last = content[content.length - 1] as Record<string, unknown>;
    blocks.push({ ...last, cache_control: EPHEMERAL });
    return { role: message.role, content: blocks };
  }
  return message;
}

// Remove every cache_control marker (deep). The server excludes markers from
// the cache key, so equality checks must too.
export function stripCacheControl<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripCacheControl(v)) as T;
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "cache_control") continue;
      out[k] = stripCacheControl(v);
    }
    return out as T;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Fingerprinting: block-level hashes of the prefix as the server keys it.

export interface PrefixFingerprint {
  staticHash: string; // tools + system (marker-stripped)
  messageHashes: string[]; // one per message
  approxTokens: number[]; // per message, chars/4 heuristic
}

function sha(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stripCacheControl(value)))
    .digest("hex");
}

export function prefixFingerprint(req: MessagesRequest): PrefixFingerprint {
  return {
    staticHash: sha([req.tools, req.system]),
    messageHashes: req.messages.map((m) => sha(m)),
    approxTokens: req.messages.map((m) =>
      Math.ceil(JSON.stringify(m.content).length / 4),
    ),
  };
}

export interface PrefixDiff {
  // null → previous prefix is intact (pure append); otherwise the index of
  // the first changed/removed message: everything from there re-writes.
  divergedAt: number | null;
  staticChanged: boolean;
  invalidatedApproxTokens: number;
}

export function diffFingerprints(
  prev: PrefixFingerprint,
  next: PrefixFingerprint,
): PrefixDiff {
  if (prev.staticHash !== next.staticHash) {
    return {
      divergedAt: 0,
      staticChanged: true,
      invalidatedApproxTokens: sum(next.approxTokens),
    };
  }
  for (let i = 0; i < prev.messageHashes.length; i++) {
    if (prev.messageHashes[i] !== next.messageHashes[i]) {
      return {
        divergedAt: i,
        staticChanged: false,
        invalidatedApproxTokens: sum(next.approxTokens.slice(i)),
      };
    }
  }
  return { divergedAt: null, staticChanged: false, invalidatedApproxTokens: 0 };
}

function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

// ---------------------------------------------------------------------------
// Ledger: remembers the last request, predicts hits, verifies with usage.

export interface CacheVerdict {
  kind: "first" | "hit" | "predicted-regen" | "unexpected-regen";
  note: string | null;
}

export class CacheLedger {
  private prev: PrefixFingerprint | null = null;
  private predicted: PrefixDiff | null = null;

  beforeRequest(req: MessagesRequest): void {
    const next = prefixFingerprint(req);
    this.predicted = this.prev ? diffFingerprints(this.prev, next) : null;
    this.prev = next;
  }

  afterResponse(usage: UsageInfo): CacheVerdict {
    const read = usage.cache_read_input_tokens ?? 0;
    const written = usage.cache_creation_input_tokens ?? 0;
    const diff = this.predicted;

    if (diff === null) {
      return { kind: "first", note: null };
    }
    if (diff.divergedAt !== null) {
      return {
        kind: "predicted-regen",
        note: `cache regen (expected): ${diff.staticChanged ? "static prefix" : `message[${diff.divergedAt}]`} changed, ~${diff.invalidatedApproxTokens} tokens re-written`,
      };
    }
    if (read === 0 && written > 0) {
      return {
        kind: "unexpected-regen",
        note: `cache miss despite stable prefix: ${written} tokens re-written (TTL expiry or below the model's minimum cacheable length)`,
      };
    }
    return { kind: "hit", note: null };
  }
}
