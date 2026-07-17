#!/usr/bin/env node
// stackpilot CLI: REPL by default, -p <prompt> for one headless turn.
//
//   stackpilot                 interactive REPL, new session
//   stackpilot -c              continue newest session for this cwd
//   stackpilot -p "…"          one turn, print result, exit
//   stackpilot --yolo          skip permission prompts
//   stackpilot --model <id>    override model

import { createInterface, type Interface } from "node:readline/promises";
import process from "node:process";
import { isCancel, select } from "@clack/prompts";
import { loadAppConfig, ConfigError } from "../config.js";
import { buildSystemPrompt } from "../core/prompt.js";
import { runTurn, type TurnIO, type TurnStats } from "../core/loop.js";
import { CacheLedger } from "../core/cache.js";
import { reduce } from "../core/reducer.js";
import { SessionStore } from "../session/store.js";
import { createRegistry } from "../tools/index.js";
import { streamMessage } from "../transport/anthropic.js";
import { runApp } from "../tui/app.js";
import { formatAge, permissionPromptPlain } from "../tui/render.js";

interface CliArgs {
  prompt?: string;
  continue_: boolean;
  yolo: boolean;
  model?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { continue_: false, yolo: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-p" || a === "--print") args.prompt = argv[++i];
    else if (a === "-c" || a === "--continue") args.continue_ = true;
    else if (a === "--yolo") args.yolo = true;
    else if (a === "--model") args.model = argv[++i];
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function openStore(cwd: string, continue_: boolean): SessionStore {
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

// Interactive -c with several sessions: arrow-key picker. Cancel exits.
async function pickSession(cwd: string): Promise<SessionStore> {
  const summaries = SessionStore.summariesFor(cwd);
  if (summaries.length === 0) {
    console.error("no previous session here — starting fresh");
    return SessionStore.create(cwd);
  }
  if (summaries.length === 1) return SessionStore.open(summaries[0]!.path);

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

function makeIO(rl: Interface | null, yolo: boolean): TurnIO {
  return {
    onText: (d) => process.stdout.write(d),
    onToolStart: (name, input) => {
      const brief = JSON.stringify(input);
      process.stderr.write(
        `\n⏺ ${name} ${brief.length > 120 ? brief.slice(0, 120) + "…" : brief}\n`,
      );
    },
    onToolEnd: (_name, output, isError) => {
      const first = output.split("\n")[0] ?? "";
      process.stderr.write(`  ${isError ? "✗" : "✓"} ${first.slice(0, 100)}\n`);
    },
    permit: async (name, input) => {
      if (yolo) return true;
      if (!rl) return false; // headless without --yolo: deny mutations
      const answer = await rl.question(permissionPromptPlain(name, input));
      const norm = answer.trim().toLowerCase();
      return norm === "y" || norm === "yes";
    },
  };
}

function printStats(stats: TurnStats, model: string): void {
  const u = stats.usage;
  process.stderr.write(
    `\n[${model}] req ${stats.requests} · tools ${stats.toolCalls} · in ${u.input_tokens} · cache-r ${u.cache_read_input_tokens} · cache-w ${u.cache_creation_input_tokens} · out ${u.output_tokens}\n`,
  );
  for (const note of stats.notes) {
    process.stderr.write(`  ⚠ ${note}\n`);
  }
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let appConfig;
  try {
    appConfig = loadAppConfig(process.env, { model: args.model });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`stackpilot: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const config = appConfig.transport;
  const pricing = appConfig.pricing;

  const cwd = process.cwd();
  const interactiveTty =
    process.stdin.isTTY === true && process.stdout.isTTY === true;
  // -p starts fresh unless -c is given (matches the documented contract; a
  // bare -p silently resuming the newest session was a P1 bug).
  const store =
    args.continue_ && args.prompt === undefined && interactiveTty
      ? await pickSession(cwd)
      : openStore(cwd, args.continue_);
  const registry = createRegistry();
  const system = buildSystemPrompt(cwd);
  const ledger = new CacheLedger();

  if (args.prompt !== undefined) {
    const io = makeIO(null, args.yolo);
    const stats = await runTurn(
      {
        store,
        registry,
        config,
        system,
        io,
        ledger,
        pricing,
        stream: streamMessage,
      },
      args.prompt,
    );
    printStats(stats, config.model);
    process.stdout.write("\n");
    return;
  }

  if (process.stdin.isTTY && process.stdout.isTTY) {
    await runApp({ store, registry, config, system, pricing });
    return;
  }

  // Piped stdin (no TTY): plain line-by-line loop, no raw mode, no colors.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const io = makeIO(rl, args.yolo);
  for (;;) {
    let line: string;
    try {
      line = (await rl.question("\n> ")).trim();
    } catch {
      break; // stdin closed
    }
    if (line === "") continue;
    if (line === "/exit" || line === "/quit") break;
    const stats = await runTurn(
      {
        store,
        registry,
        config,
        system,
        io,
        ledger,
        pricing,
        stream: streamMessage,
      },
      line,
    );
    printStats(stats, config.model);
  }
  rl.close();
}

const isDirect =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "");
if (isDirect) {
  main().catch((err) => {
    console.error(`stackpilot: ${(err as Error).message}`);
    process.exit(1);
  });
}
