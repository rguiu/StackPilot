import { isCancel, select } from "@clack/prompts";
import { reduce } from "../core/reducer.js";
import { SessionStore } from "../session/store.js";
import { formatAge } from "../tui/render.js";
import process from "node:process";

export function openStore(cwd: string, continue_: boolean): SessionStore {
  if (continue_) {
    const newest = SessionStore.newestFor(cwd);
    if (newest) {
      const store = SessionStore.open(newest);
      const n = reduce(store.all()).messages.length;
      console.error(`resumed ${store.sessionId} (${n} messages)`);
      return store;
    }
    console.error("no previous session here — starting fresh");
  }
  return SessionStore.create(cwd);
}

export async function pickSession(cwd: string): Promise<SessionStore> {
  const summaries = SessionStore.summariesFor(cwd);
  if (summaries.length === 0) {
    console.error("no previous session here — starting fresh");
    return SessionStore.create(cwd);
  }
  if (summaries.length === 1 && summaries[0])
    return SessionStore.open(summaries[0].path);

  const now = Date.now();
  const choice = await select({
    message: "Resume which session?",
    options: summaries.slice(0, 10).map((s) => ({
      value: s.path,
      label: `${s.id.slice(0, 8)} · ${formatAge(now - s.mtimeMs)} · ${(s.preview ?? "(no prompt)").slice(0, 50)}`,
    })),
  });
  if (isCancel(choice)) {
    console.error("cancelled");
    process.exit(0);
  }
  const store = SessionStore.open(choice);
  const n = reduce(store.all()).messages.length;
  console.error(`resumed ${store.sessionId} (${n} messages)`);
  return store;
}
