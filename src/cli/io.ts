import { createInterface, type Interface } from "node:readline/promises";
import { execShellPassthrough } from "../util/shell-exec.js";
import {
  runTurn,
  prewarmCache,
  type TurnIO,
  type TurnStats,
} from "../core/loop.js";
import {
  permissionPromptPlain,
  toolStartLine,
  toolEndLine,
} from "../tui/render.js";
import type { AppConfig } from "../config.js";
import type { CacheLedger } from "../core/cache.js";
import type { Registry } from "../tools/index.js";
import type { TransportConfig } from "../transport/anthropic.js";
import type { SessionState } from "../core/policies.js";
import type { SessionStore } from "../session/store.js";
import type { ModelPricing } from "../config.js";
import type { ModeState } from "../core/mode.js";

export interface RunDeps {
  cwd: string;
  store: SessionStore;
  registry: Registry;
  config: TransportConfig;
  system: string;
  ledger: CacheLedger;
  pricing: Record<string, ModelPricing>;
  stream: ReturnType<
    typeof import("../transport/anthropic.js").streamWithRetry
  >;
  hooks: AppConfig["hooks"];
  sessionState: SessionState;
  maxToolResultChars: number;
  autoCompactAtTokens: number;
  // Idle gap (ms) before a REPL turn that triggers a cache keep-alive. 0 off.
  cachePrewarmIdleMs: number;
  mode: ModeState;
}

export function makeIO(
  rl: Interface | null,
  yolo: boolean,
  json = false,
): TurnIO {
  if (json) {
    return {
      onText: (d) =>
        process.stdout.write(
          JSON.stringify({ type: "text", content: d }) + "\n",
        ),
      onToolStart: (name, input) =>
        process.stdout.write(
          JSON.stringify({ type: "tool_start", name, input }) + "\n",
        ),
      onToolEnd: (_name, output, isError) =>
        process.stdout.write(
          JSON.stringify({
            type: "tool_end",
            output: output.slice(0, 500),
            isError,
          }) + "\n",
        ),
      permit: () => {
        if (yolo) return Promise.resolve({ allowed: true });
        return Promise.resolve({ allowed: false });
      },
    };
  }

  return {
    onText: (d) => process.stdout.write(d),
    onToolStart: (name, input) => {
      process.stderr.write(`\n${toolStartLine(name, input)}\n`);
    },
    onToolEnd: (_name, output, isError) => {
      process.stderr.write(`${toolEndLine(output, isError)}\n`);
    },
    permit: async (name, input) => {
      if (yolo) return { allowed: true };
      if (!rl) return { allowed: false };
      const answer = await rl.question(permissionPromptPlain(name, input));
      const norm = answer.trim().toLowerCase();
      if (norm === "y" || norm === "yes") return { allowed: true };
      if (norm.startsWith("n ") || norm.startsWith("no ")) {
        return { allowed: false, reason: norm.slice(norm.indexOf(" ") + 1) };
      }
      return { allowed: false };
    },
  };
}

export function printStats(
  stats: TurnStats,
  model: string,
  json = false,
): void {
  if (json) {
    process.stdout.write(
      JSON.stringify({
        type: "turn_end",
        model,
        requests: stats.requests,
        toolCalls: stats.toolCalls,
        usage: stats.usage,
        costUsd: stats.costUsd,
      }) + "\n",
    );
    return;
  }
  const u = stats.usage;
  process.stderr.write(
    `\n[${model}] req ${stats.requests} · tools ${stats.toolCalls} · in ${u.input_tokens} · cache-r ${u.cache_read_input_tokens} · cache-w ${u.cache_creation_input_tokens} · out ${u.output_tokens}\n`,
  );
  for (const note of stats.notes) {
    process.stderr.write(`  ⚠ ${note}\n`);
  }
}

export async function runHeadless(
  deps: RunDeps,
  prompt: string,
  json: boolean,
  yolo: boolean,
): Promise<void> {
  const io = makeIO(null, yolo, json);
  const stats = await runTurn({ ...deps, io }, prompt);
  printStats(stats, deps.config.model, json);
}

export async function runRepl(
  deps: RunDeps,
  json: boolean,
  yolo: boolean,
): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const io = makeIO(rl, yolo, json);
  // Timestamp of the last completed turn; drives idle cache keep-alive.
  let lastTurnEndedAt = Date.now();
  for (;;) {
    let line: string;
    try {
      line = (await rl.question("\n> ")).trim();
    } catch {
      break;
    }
    if (line === "") continue;
    if (line === "/exit" || line === "/quit") break;
    if (line.startsWith("!")) {
      const cmd = line.slice(1).trim();
      if (cmd) execShellPassthrough(cmd, deps.cwd);
      continue;
    }
    // The user was idle long enough that the cached prefix may have expired;
    // refresh it before the (potentially large) real request re-writes it.
    if (
      deps.cachePrewarmIdleMs > 0 &&
      Date.now() - lastTurnEndedAt >= deps.cachePrewarmIdleMs
    ) {
      const warmed = await prewarmCache({ ...deps, io });
      if (warmed && !json) {
        process.stderr.write("  ↻ cache kept warm\n");
      }
    }
    const stats = await runTurn({ ...deps, io }, line);
    printStats(stats, deps.config.model, json);
    lastTurnEndedAt = Date.now();
  }
  rl.close();
}
