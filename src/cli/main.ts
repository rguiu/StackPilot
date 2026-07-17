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
import { resolveConfig, ConfigError } from "../config.js";
import { buildSystemPrompt } from "../core/prompt.js";
import { runTurn, type TurnIO, type TurnStats } from "../core/loop.js";
import { reduce } from "../core/reducer.js";
import { SessionStore } from "../session/store.js";
import { createRegistry } from "../tools/index.js";
import { streamMessage } from "../transport/anthropic.js";

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
      const preview =
        name === "Bash"
          ? String(input.command ?? "")
          : String(input.file_path ?? "");
      const answer = await rl.question(
        `allow ${name}(${preview.slice(0, 80)})? [y/N] `,
      );
      return answer.trim().toLowerCase().startsWith("y");
    },
  };
}

function printStats(stats: TurnStats, model: string): void {
  const u = stats.usage;
  process.stderr.write(
    `\n[${model}] req ${stats.requests} · tools ${stats.toolCalls} · in ${u.input_tokens} · cache-r ${u.cache_read_input_tokens} · cache-w ${u.cache_creation_input_tokens} · out ${u.output_tokens}\n`,
  );
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let config;
  try {
    config = resolveConfig(process.env, { model: args.model });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`stackpilot: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const cwd = process.cwd();
  const store = openStore(cwd, args.continue_ || args.prompt !== undefined);
  const registry = createRegistry();
  const system = buildSystemPrompt(cwd);

  if (args.prompt !== undefined) {
    const io = makeIO(null, args.yolo);
    const stats = await runTurn(
      { store, registry, config, system, io, stream: streamMessage },
      args.prompt,
    );
    printStats(stats, config.model);
    process.stdout.write("\n");
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const io = makeIO(rl, args.yolo);
  console.error(
    `stackpilot · ${config.model} · session ${store.sessionId.slice(0, 8)} · /exit to quit`,
  );
  for (;;) {
    const line = (await rl.question("\n> ")).trim();
    if (line === "") continue;
    if (line === "/exit" || line === "/quit") break;
    const stats = await runTurn(
      { store, registry, config, system, io, stream: streamMessage },
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
