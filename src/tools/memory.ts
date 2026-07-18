// Session memory: persistent, searchable index of past sessions.
// Stored in ~/.stackpilot/memory/index.db (SQLite + FTS5).
// Extraction runs on session end; search tools expose the index.

import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ToolDef, type ToolResult } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  cwd TEXT NOT NULL,
  branch TEXT DEFAULT '',
  first_prompt TEXT DEFAULT '',
  file_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  first_prompt, cwd, branch, content='sessions', content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS session_files (
  session_id TEXT NOT NULL,
  path TEXT NOT NULL,
  op TEXT NOT NULL CHECK(op IN ('read', 'write')),
  PRIMARY KEY (session_id, path, op)
);

CREATE VIRTUAL TABLE IF NOT EXISTS session_files_fts USING fts5(
  path, content='session_files', content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS session_errors (
  session_id TEXT NOT NULL,
  text TEXT NOT NULL
);
`;

export function openMemoryDb(home: string): Database.Database {
  const dir = join(home, ".stackpilot", "memory");
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "index.db"));
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

interface SessionMeta {
  id: string;
  timestamp: string;
  cwd: string;
  branch: string;
  firstPrompt: string;
  files: { path: string; op: string }[];
  errors: string[];
  costUsd: number;
}

function extractMeta(jsonlPath: string): SessionMeta | null {
  let raw: string;
  try {
    raw = readFileSync(jsonlPath, "utf8");
  } catch {
    return null;
  }
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const id = jsonlPath.split("/").pop()?.replace(".jsonl", "") ?? "unknown";
  let timestamp = "";
  const cwd = "";
  const branch = "";
  let firstPrompt = "";
  const filesSeen = new Set<string>();
  const errors: string[] = [];
  let costUsd = 0;

  for (const line of lines) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!timestamp) {
      const ts = event.timestamp;
      if (typeof ts === "string") timestamp = ts;
    }

    const msg = event.message as
      | {
          role?: string;
          content?: unknown;
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
        }
      | undefined;

    if (event.type === "user" && !firstPrompt) {
      if (msg?.content) {
        if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            const b = block as { type?: string; text?: string };
            if (b.type === "text" && b.text) {
              firstPrompt = b.text.slice(0, 500);
              break;
            }
          }
        } else if (typeof msg.content === "string") {
          firstPrompt = msg.content.slice(0, 500);
        }
      }
    }

    // Detect file writes and errors from tool_result blocks inside user messages.
    if (event.type === "user" && msg?.content && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const b = block as {
          type?: string;
          tool_use_id?: string;
          content?: string;
          is_error?: boolean;
        };
        if (b.type !== "tool_result") continue;

        const text = b.content;
        if (typeof text === "string") {
          if (
            text.startsWith("wrote ") ||
            text.startsWith("replaced ") ||
            text.startsWith("patched ") ||
            text.includes("bytes to")
          ) {
            const pathMatch = /\b(\/[^\s]+)/.exec(text);
            if (pathMatch) {
              const fp = pathMatch[1];
              const key = `write:${fp}`;
              if (!filesSeen.has(key)) filesSeen.add(key);
            }
          }
          if (b.is_error === true) {
            errors.push(text.slice(0, 300));
          }
        }
      }
    }

    // Extract cost from assistant usage.
    if (event.type === "assistant" && msg?.usage) {
      const usage = msg.usage;
      const input =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
      const output = usage.output_tokens ?? 0;
      // Approximate cost: $1/MTok input, $5/MTok output (Haiku rates).
      costUsd += (input / 1_000_000) * 1.0 + (output / 1_000_000) * 5.0;
    }
  }

  if (!timestamp) timestamp = new Date().toISOString();

  if (!firstPrompt && lines.length > 0) {
    try {
      const last = JSON.parse(lines[lines.length - 1] as string) as Record<
        string,
        unknown
      >;
      if (last.type === "user") {
        const msg = last.message as { content?: unknown } | undefined;
        if (msg?.content && typeof msg.content === "string") {
          firstPrompt = msg.content.slice(0, 500);
        }
      }
    } catch {
      // ignore
    }
  }

  return {
    id,
    timestamp,
    cwd,
    branch,
    firstPrompt,
    files: [...filesSeen].map((key) => {
      const idx = key.indexOf(":");
      return {
        op: key.slice(0, idx),
        path: key.slice(idx + 1),
      };
    }),
    errors,
    costUsd,
  };
}

export function storeSessionMeta(
  db: Database.Database,
  jsonlPath: string,
  cwd: string,
): void {
  const meta = extractMeta(jsonlPath);
  if (!meta) return;

  const stmt = db.prepare(
    `INSERT OR REPLACE INTO sessions (id, timestamp, cwd, branch, first_prompt, file_count, error_count, cost_usd)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  stmt.run(
    meta.id,
    meta.timestamp,
    meta.cwd || cwd,
    meta.branch,
    meta.firstPrompt,
    meta.files.length,
    meta.errors.length,
    meta.costUsd,
  );

  const fileStmt = db.prepare(
    "INSERT OR IGNORE INTO session_files (session_id, path, op) VALUES (?, ?, ?)",
  );
  for (const f of meta.files) {
    fileStmt.run(meta.id, f.path, f.op);
  }

  const errStmt = db.prepare(
    "INSERT INTO session_errors (session_id, text) VALUES (?, ?)",
  );
  for (const e of meta.errors) {
    errStmt.run(meta.id, e);
  }
}

export function createSearchMemoryTool(db: Database.Database): ToolDef {
  return {
    name: "SearchMemory",
    description:
      "Search past sessions by keyword (FTS over prompts, CWDs, branches). " +
      "Returns matching session IDs, first prompts, and timestamps.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search term to find in past session data",
        },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
    execute(input): Promise<ToolResult> {
      const query = typeof input.query === "string" ? input.query.trim() : "";
      if (!query) {
        return Promise.resolve({
          output: '"query" must be a non-empty string',
          isError: true,
        });
      }
      const limit =
        typeof input.limit === "number" && input.limit > 0
          ? Math.min(input.limit, 50)
          : 10;

      let rows: unknown[];
      try {
        const stmt = db.prepare(
          `SELECT s.id, s.timestamp, s.first_prompt, s.cwd, s.branch, s.cost_usd
           FROM sessions_fts f
           JOIN sessions s ON s.rowid = f.rowid
           WHERE sessions_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        );
        rows = stmt.all(query, limit);
      } catch {
        // FTS5 MATCH may fail on special chars — fall back to LIKE
        const stmt = db.prepare(
          `SELECT id, timestamp, first_prompt, cwd, branch, cost_usd
           FROM sessions
           WHERE first_prompt LIKE ? OR cwd LIKE ?
           ORDER BY timestamp DESC
           LIMIT ?`,
        );
        const likeVar = `%${query}%`;
        rows = stmt.all(likeVar, likeVar, limit);
      }

      if (rows.length === 0) {
        return Promise.resolve({
          output: `no sessions matching "${query}"`,
        });
      }

      const lines = rows.map((r) => {
        const rec = r as Record<string, unknown>;
        const id = (rec.id as string).slice(0, 8);
        const prompt = (rec.first_prompt as string).slice(0, 80);
        const ts = (rec.timestamp as string).slice(0, 10);
        return `${id} [${ts}] ${prompt}`;
      });
      return Promise.resolve({ output: lines.join("\n") });
    },
  };
}

export function createSearchFilesTool(db: Database.Database): ToolDef {
  return {
    name: "SearchFiles",
    description:
      "Find sessions that read or wrote a specific file path. Use to find " +
      "past work on a particular file.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path to search for (partial match)",
        },
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: ["path"],
    },
    execute(input): Promise<ToolResult> {
      const pathQuery = typeof input.path === "string" ? input.path.trim() : "";
      if (!pathQuery) {
        return Promise.resolve({
          output: '"path" must be a non-empty string',
          isError: true,
        });
      }
      const limit =
        typeof input.limit === "number" && input.limit > 0
          ? Math.min(input.limit, 50)
          : 20;

      let rows: unknown[];
      try {
        const stmt = db.prepare(
          `SELECT f.session_id, f.op, s.first_prompt, s.timestamp
           FROM session_files_fts ff
           JOIN session_files f ON f.rowid = ff.rowid
           JOIN sessions s ON s.id = f.session_id
           WHERE session_files_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        );
        rows = stmt.all(pathQuery, limit);
      } catch {
        const stmt = db.prepare(
          `SELECT f.session_id, f.op, s.first_prompt, s.timestamp
           FROM session_files f
           JOIN sessions s ON s.id = f.session_id
           WHERE f.path LIKE ?
           ORDER BY s.timestamp DESC
           LIMIT ?`,
        );
        rows = stmt.all(`%${pathQuery}%`, limit);
      }

      if (rows.length === 0) {
        return Promise.resolve({
          output: `no sessions touching files matching "${pathQuery}"`,
        });
      }

      const lines = rows.map((r) => {
        const rec = r as Record<string, unknown>;
        const sid = (rec.session_id as string).slice(0, 8);
        const op = rec.op as string;
        const prompt = (rec.first_prompt as string).slice(0, 80);
        const ts = (rec.timestamp as string).slice(0, 10);
        return `${sid} [${ts}] ${op}: ${prompt}`;
      });
      return Promise.resolve({ output: lines.join("\n") });
    },
  };
}
