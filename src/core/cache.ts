// Client side of Anthropic prompt caching.
//
// The cache itself lives on Anthropic's servers; nothing is stored locally.
// What we own is the KEY: byte-stable prefixes plus cache_control markers
// telling the server where reusable prefixes end — and a fingerprint of the
// previous request so we can PREDICT what a stack change will invalidate
// and DETECT regenerations from the usage counters the server returns.
//
// Breakpoint layout (3 of the 4 allowed):
//   1. static  — first system block: identity + static rules (never changes
//      within a session; cache persists across turns)
//   2. static  — second system block: instructions + git + skills (may
//      change between sessions but not within; separate cache from block 1
//      so a CLAUDE.md reload only invalidates this block)
//   3. moving  — last content block of the last message: each turn extends
//      the cached conversation; the server prefix-matches against recent
//      breakpoints, so appending is a hit and mutating history is a miss.

import { sha256 } from "../util/hash.js";
import type { ContentBlock } from "../types.js";
import type { MessagesRequest, UsageInfo } from "../transport/anthropic.js";

type Message = { role: "user" | "assistant"; content: ContentBlock[] };

const EPHEMERAL = { type: "ephemeral" } as const;

export function applyCacheControl(
  system: string,
  tools: unknown[],
  messages: Message[],
): MessagesRequest {
  // Split system into 2 cache blocks: static rules (identity, security,
  // coding conventions, tool usage) vs dynamic content (skills, CLAUDE.md).
  // This way a CLAUDE.md change only invalidates block 1, not block 0.
  const splitIdx = findDynamicSplit(system);
  const systemBlocks: {
    type: "text";
    text: string;
    cache_control?: { type: "ephemeral" };
  }[] = [];

  if (splitIdx > 0) {
    const staticBlock = system.slice(0, splitIdx).trimEnd();
    const dynamicBlock = system.slice(splitIdx).trimStart();
    if (staticBlock.length > 0) {
      systemBlocks.push({
        type: "text",
        text: staticBlock,
        cache_control: EPHEMERAL,
      });
    }
    if (dynamicBlock.length > 0) {
      systemBlocks.push({
        type: "text",
        text: dynamicBlock,
        cache_control: EPHEMERAL,
      });
    }
  } else {
    systemBlocks.push({ type: "text", text: system, cache_control: EPHEMERAL });
  }

  // The moving breakpoint goes on the last message that actually has content.
  // Marking the literal last message would silently drop the breakpoint when
  // that message is empty (e.g. a trailing user turn with no blocks yet),
  // costing a full cache re-read on the next turn.
  let markIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i]?.content;
    if (Array.isArray(c) && c.length > 0) {
      markIdx = i;
      break;
    }
  }
  const marked =
    markIdx === -1
      ? messages
      : messages.map((m, i) => (i === markIdx ? markLastBlock(m) : m));

  return { system: systemBlocks, tools, messages: marked };
}

// Heuristic split point: where dynamic per-session content begins.
// Sections: "Available skills", "Project and user instructions",
// "User-level instructions".
function findDynamicSplit(system: string): number {
  const patterns = [
    "Available skills",
    "# Project and user instructions",
    "# User-level instructions",
  ];
  for (const pat of patterns) {
    const idx = system.indexOf(pat);
    if (idx > 0) return idx;
  }
  return -1;
}

function markLastBlock(message: Message): Message {
  const { content } = message;
  if (Array.isArray(content) && content.length > 0) {
    const blocks = content.slice(0, -1);
    const last = content[content.length - 1];
    if (last) {
      blocks.push({ ...last, cache_control: EPHEMERAL });
    }
    return { role: message.role, content: blocks };
  }
  return message;
}

// Remove every cache_control marker (deep). The server excludes markers from
// the cache key, so equality checks must too.
export function stripCacheControl<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v: unknown) => stripCacheControl(v)) as unknown as T;
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
  return sha256(stripCacheControl(value));
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
