// WebFetch: HTTP GET tool. Fetch a URL and return its content as text.
// Read-only, run-permitless. Uses native fetch, 10s default timeout.
//
// SSRF guard: because this tool is permitless (no user prompt) and an agent
// may act on untrusted instructions, we refuse URLs that resolve to loopback,
// link-local, or private (RFC1918) addresses — this blocks cloud metadata
// endpoints (169.254.169.254) and internal services. Redirects are followed
// MANUALLY so every hop is re-validated; native redirect:"follow" would let a
// public URL bounce to an internal one unchecked.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { requireString, type ToolDef, type ToolResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 80_000;
const MAX_REDIRECTS = 5;

// True for addresses that must never be reachable via this tool.
export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts as [number, number, number, number];
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local (metadata)
    if (a === 0) return true; // "this host"
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true; // loopback / unspecified
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local
    // IPv4-mapped (::ffff:127.0.0.1) — extract and re-check.
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isBlockedAddress(mapped[1]);
    return false;
  }
  return false;
}

// Resolve a hostname and reject if it (or any resolved address) is blocked.
// Returns an error string when blocked, null when allowed.
async function guardHost(hostname: string): Promise<string | null> {
  const host = hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) {
    return `refusing to fetch internal host "${host}"`;
  }
  if (isIP(host)) {
    return isBlockedAddress(host)
      ? `refusing to fetch internal address "${host}"`
      : null;
  }
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch (err) {
    return `DNS lookup failed for "${host}": ${err instanceof Error ? err.message : String(err)}`;
  }
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      return `refusing to fetch "${host}" — resolves to internal address ${address}`;
    }
  }
  return null;
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<{ res: Response } | { error: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return { error: `invalid URL: ${current}` };
    }
    const blocked = await guardHost(parsed.hostname);
    if (blocked) return { error: blocked };

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    let res: Response;
    try {
      res = await fetch(current, {
        signal: controller.signal,
        headers: {
          "user-agent": "stackpilot/0.1",
          accept:
            "text/html,text/plain,application/json,text/markdown;q=0.9,*/*;q=0.8",
        },
        redirect: "manual",
      });
    } finally {
      clearTimeout(timer);
    }

    // Follow redirects ourselves so each hop is re-validated.
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { res };
      current = new URL(location, current).href;
      continue;
    }
    return { res };
  }
  return { error: `too many redirects (>${MAX_REDIRECTS})` };
}

export const webFetchTool: ToolDef = {
  name: "WebFetch",
  description:
    "Fetch content from a URL. Returns the response body as text. " +
    "Use for reading documentation, API responses, or any web content " +
    "the agent needs to understand.",
  runPermitless: true,
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch",
      },
      format: {
        type: "string",
        enum: ["text", "markdown", "html"],
        description: "Preferred content format. Defaults to text.",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (max 30). Defaults to 10.",
      },
    },
    required: ["url"],
  },
  async execute(input): Promise<ToolResult> {
    const url = requireString(input, "url");
    const format = (input.format as string | undefined) ?? "text";
    const timeoutSec =
      typeof input.timeout === "number" && input.timeout > 0
        ? Math.min(input.timeout, 30) * 1000
        : DEFAULT_TIMEOUT_MS;

    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return {
        output: `invalid URL: must start with http:// or https://`,
        isError: true,
      };
    }

    let outcome: { res: Response } | { error: string };
    try {
      outcome = await fetchWithTimeout(url, timeoutSec);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return {
          output: `request timed out after ${timeoutSec / 1000}s`,
          isError: true,
        };
      }
      return {
        output: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    if ("error" in outcome) {
      return { output: outcome.error, isError: true };
    }
    const res = outcome.res;

    let body: string;
    try {
      body = await res.text();
    } catch {
      return { output: "failed to read response body", isError: true };
    }

    const contentType = res.headers.get("content-type") ?? "";
    const truncated =
      body.length > MAX_OUTPUT
        ? `${body.slice(0, MAX_OUTPUT)}\n\n[truncated ${body.length - MAX_OUTPUT} chars]`
        : body;

    const header = [
      `Status: ${res.status} ${res.statusText}`,
      `Content-Type: ${contentType}`,
      `Length: ${body.length} chars`,
      `Requested format: ${format}`,
      "",
    ].join("\n");

    return { output: `${header}\n${truncated}` };
  },
};
