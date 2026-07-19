// SearchHistory: query the engineering memory that the aap proxy builds
// from every recorded session (see ai-agent-profiler `aap search`). The
// agent can ask "have we solved something like this before?" instead of
// re-exploring from scratch.
//
// Read-only, network-local. Origin resolution: $STACKPILOT_AAP_ORIGIN,
// else the origin of $ANTHROPIC_BASE_URL (when running through the proxy
// that is the proxy itself), else http://127.0.0.1:8080. Degrades to an
// error result when aap isn't reachable — never blocks the turn.

import {
  optionalString,
  requireString,
  truncate,
  type ToolDef,
  type ToolResult,
} from "./types.js";

const MAX_OUTPUT = 20_000;

interface SearchHit {
  requestId: string;
  sessionId: string;
  ts: string | null;
  source: string;
  snippet: string;
  cwd: string | null;
  client: string | null;
}

export function aapOrigin(env: NodeJS.ProcessEnv): string {
  if (env.STACKPILOT_AAP_ORIGIN) return env.STACKPILOT_AAP_ORIGIN;
  if (env.ANTHROPIC_BASE_URL) {
    try {
      return new URL(env.ANTHROPIC_BASE_URL).origin;
    } catch {
      // fall through to the default
    }
  }
  return "http://127.0.0.1:8080";
}

export function formatHits(hits: readonly SearchHit[]): string {
  if (hits.length === 0) {
    return "no matches in the engineering memory";
  }
  return hits
    .map((h) => {
      const ts = h.ts ? h.ts.slice(0, 16).replace("T", " ") : "?";
      const cwd = h.cwd ? ` · ${h.cwd}` : "";
      return `${ts} · session ${h.sessionId.slice(0, 12)} · ${h.client ?? "?"} · ${h.source}${cwd}\n  ${h.snippet}`;
    })
    .join("\n");
}

export const searchHistoryTool: ToolDef = {
  name: "SearchHistory",
  description:
    "Full-text search over ALL previously recorded agent sessions (prompts, responses, tool calls across projects). Use before solving a problem that may have been tackled before, e.g. 'have we fixed this file/error/topic previously?'.",
  runPermitless: true,
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search terms (FTS syntax supported: AND, OR, quotes)",
      },
      limit: { type: "number", description: "Max results (default 8)" },
    },
    required: ["query"],
  },
  async execute(input): Promise<ToolResult> {
    const query = requireString(input, "query");
    optionalString(input, "path"); // tolerated, ignored
    const limit = typeof input.limit === "number" ? input.limit : 8;
    const origin = aapOrigin(process.env);
    const url = `${origin}/search?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(String(limit))}`;

    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    } catch {
      return {
        output: `engineering memory unavailable (aap serve not reachable at ${origin})`,
        isError: true,
      };
    }
    if (!res.ok) {
      return {
        output: `engineering memory unavailable (${origin} answered HTTP ${res.status} — old aap version without /search?)`,
        isError: true,
      };
    }
    const hits = (await res.json()) as SearchHit[];
    return { output: truncate(formatHits(hits), MAX_OUTPUT) };
  },
};
