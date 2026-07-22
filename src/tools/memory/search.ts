import Database from "better-sqlite3";
import { type ToolDef, type ToolResult } from "../types.js";

export function createSearchMemoryTool(db: Database.Database): ToolDef {
  return {
    name: "SearchMemory",
    description:
      "Search past sessions by keyword (FTS over prompts, CWDs, branches). " +
      "Returns matching session IDs, first prompts, and timestamps.",
    runPermitless: true,
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
    runPermitless: true,
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
