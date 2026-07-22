import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { firstTextBlock } from "../../util/message.js";
import type { ModelPricing } from "../../config.js";

function gitBranch(cwd: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
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

function extractMeta(
  jsonlPath: string,
  sessionCwd: string,
  pricing?: Partial<ModelPricing>,
): SessionMeta | null {
  const inputPrice = pricing?.inputPerMTok ?? 1.0;
  const outputPrice = pricing?.outputPerMTok ?? 5.0;
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
  const cwd = sessionCwd;
  const branch = gitBranch(sessionCwd);
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
        const text = firstTextBlock(msg.content);
        if (text) firstPrompt = text.slice(0, 500);
      }
    }

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

    if (event.type === "assistant" && msg?.usage) {
      const usage = msg.usage;
      const input =
        (usage.input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0);
      const output = usage.output_tokens ?? 0;
      costUsd +=
        (input / 1_000_000) * inputPrice + (output / 1_000_000) * outputPrice;
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
  pricing?: Partial<ModelPricing>,
): void {
  const meta = extractMeta(jsonlPath, cwd, pricing);
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
