import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

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
