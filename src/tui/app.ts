// TUI: readline for input, stdout for streaming output. Bottom-bar
// separator + status line between turns. Esc via InterruptController.

import { createInterface } from "node:readline/promises";
import process from "node:process";
import { execShellPassthrough } from "../util/shell-exec.js";
import { SPINNER_FRAMES, cyan, dim } from "./ansi.js";
import { MarkdownRenderer } from "./markdown.js";
import { InterruptController, ModeController, isAbort } from "./interrupt.js";
import { handleSlashCommand, type CommandContext } from "./commands.js";
import {
  createModeState,
  modeLine,
  nextMode,
  type ModeState,
} from "../core/mode.js";
import {
  interrupted,
  permissionLabel,
  richToolOutput,
  statsLine,
  toolStartLine,
} from "./render.js";
import {
  runTurn,
  prewarmCache,
  type TurnIO,
  type TurnStats,
} from "../core/loop.js";
import { CacheLedger } from "../core/cache.js";
import { formatUsd } from "../core/cost.js";
import type { SessionStore } from "../session/store.js";
import type { Registry } from "../tools/index.js";
import type { TransportConfig } from "../transport/anthropic.js";
import { streamWithRetry } from "../transport/anthropic.js";
import type { HookConfig } from "../core/hooks.js";
import type { SessionState } from "../core/policies.js";
import type { ModelPricing } from "../config.js";
import { select, isCancel, text } from "@clack/prompts";
import { restoreReadlineTty } from "./interrupt.js";

export interface AppDeps {
  cwd: string;
  store: SessionStore;
  registry: Registry;
  config: TransportConfig;
  system: string;
  pricing?: Record<string, ModelPricing>;
  autoCompactAtTokens?: number;
  hooks?: {
    preTool?: HookConfig;
    postTool?: HookConfig;
    sessionStart?: HookConfig;
    sessionEnd?: HookConfig;
    preCompact?: HookConfig;
    postCompact?: HookConfig;
  };
  sessionState?: SessionState;
  maxToolResultChars?: number;
  // Idle gap (ms) before a turn that triggers a cache keep-alive. 0 disables.
  cachePrewarmIdleMs?: number;
  maxIterations?: number;
  mode?: ModeState;
}

export async function runApp(deps: AppDeps): Promise<void> {
  const { store, registry, config, system, pricing } = deps;
  const stream = streamWithRetry(config);
  const autoCompactState = { value: deps.autoCompactAtTokens ?? 0 };
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const interrupt = new InterruptController();
  const mode: ModeState = deps.mode ?? createModeState();
  const promptStr = `${cyan("›")} `;
  const modeCtl = new ModeController(() => {
    mode.current = nextMode(mode.current);
    // Clear the current input line, print the updated mode indicator, then
    // redraw the prompt with whatever the user had already typed.
    const typed = rl.line;
    process.stdout.write(
      `\r\x1b[K${modeLine(mode.current)}\n\r\x1b[K${promptStr}${typed}`,
    );
  });
  const turns: TurnStats[] = [];
  const sessionAllow = new Set<string>();
  const ledger = new CacheLedger();
  const md = new MarkdownRenderer();
  let streamedAnything = false;
  const prewarmIdleMs = deps.cachePrewarmIdleMs ?? 0;
  // Timestamp of the last completed turn; drives the idle cache keep-alive.
  let lastTurnEndedAt = Date.now();

  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let spinnerFrame = 0;

  function startSpinner(label: string): void {
    if (spinnerTimer) return;
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      const frame = SPINNER_FRAMES[spinnerFrame] ?? " ";
      process.stderr.write(`\r\x1b[K${cyan(frame)} ${dim(label)}`);
    }, 80);
  }

  function stopSpinner(): void {
    if (!spinnerTimer) return;
    clearInterval(spinnerTimer);
    spinnerTimer = null;
    process.stderr.write("\r\x1b[K");
  }

  const io: TurnIO = {
    onText: (delta) => {
      if (!streamedAnything) {
        stopSpinner();
        streamedAnything = true;
        process.stdout.write("\n");
      }
      const rendered = md.push(delta);
      if (rendered.length > 0) process.stdout.write(rendered + "\n");
    },
    onToolStart: (name, input) => {
      stopSpinner();
      const flushed = md.flush();
      if (flushed.length > 0) process.stdout.write(flushed + "\n");
      md.reset();
      process.stdout.write(`\n${toolStartLine(name, input)}\n`);
      streamedAnything = false;
      startSpinner("running…");
    },
    onToolEnd: (name, output, isError) => {
      stopSpinner();
      process.stdout.write(`${richToolOutput(name, output, isError)}\n`);
      startSpinner("thinking…");
    },
    permit: async (name, input) => {
      stopSpinner();
      if (sessionAllow.has(name)) return { allowed: true };
      interrupt.disarm();
      try {
        const choice = await select({
          message: permissionLabel(name, input),
          options: [
            { value: "once", label: "Allow once" },
            { value: "session", label: `Allow ${name} for this session` },
            { value: "deny_feedback", label: "Deny (with feedback)" },
            { value: "deny", label: "Deny" },
          ],
        });
        if (isCancel(choice)) {
          interrupt.abort();
          const err = new Error("aborted by user");
          err.name = "AbortError";
          throw err;
        }
        if (choice === "session") sessionAllow.add(name);
        if (choice === "once" || choice === "session") return { allowed: true };
        if (choice === "deny_feedback") {
          const feedback = await text({
            message: "Why are you denying this tool call?",
            placeholder: "Reason...",
          });
          if (isCancel(feedback)) return { allowed: false };
          return {
            allowed: false,
            reason: feedback.trim() || undefined,
          };
        }
        return { allowed: false };
      } finally {
        restoreReadlineTty();
        interrupt.arm();
      }
    },
  };

  const cmdCtx: CommandContext = {
    store,
    registry,
    config,
    system,
    pricing,
    interrupt,
    stream,
    hooks: deps.hooks
      ? {
          preCompact: deps.hooks.preCompact,
          postCompact: deps.hooks.postCompact,
        }
      : undefined,
    turns,
    autoCompactState,
    mode,
    startSpinner,
    stopSpinner,
  };

  const totalCost = turns.reduce((sum, t) => sum + (t.costUsd ?? 0), 0);
  const costStr = pricing ? ` ${formatUsd(totalCost)}` : "";
  process.stdout.write(
    [
      `${cyan("stackpilot")} ${dim("·")} ${config.model} ${dim("·")} session ${store.sessionId.slice(0, 8)}`,
      dim(`cwd ${deps.cwd}${costStr}`),
      dim(
        "esc interrupts · tab switches mode · ! for shell · /help for commands",
      ),
      "",
    ].join("\n"),
  );

  try {
    for (;;) {
      if (turns.length > 0) {
        const last = turns[turns.length - 1];
        if (last) process.stdout.write("\n");
      } else {
        process.stdout.write("\n");
      }

      process.stdout.write(modeLine(mode.current) + "\n");
      let line: string;
      modeCtl.arm();
      try {
        line = (await rl.question(promptStr)).trim();
      } catch {
        break;
      } finally {
        modeCtl.disarm();
      }
      if (line === "") continue;

      if (line.startsWith("!")) {
        const cmd = line.slice(1).trim();
        if (cmd) execShellPassthrough(cmd, deps.cwd);
        continue;
      }

      if (line.startsWith("/")) {
        const result = handleSlashCommand(line, cmdCtx);
        if (result === "break") break;
        continue;
      }

      interrupt.reset();
      interrupt.arm();
      streamedAnything = false;
      md.reset();
      const turnDeps = {
        cwd: deps.cwd,
        store,
        registry,
        config,
        system,
        io,
        ledger,
        pricing,
        signal: interrupt.signal,
        stream,
        hooks: deps.hooks,
        sessionState: deps.sessionState,
        maxToolResultChars: deps.maxToolResultChars,
        autoCompactAtTokens: autoCompactState.value,
        maxIterations: deps.maxIterations,
        mode,
      };
      // The user was idle long enough that the cached prefix may have expired;
      // refresh it before the real request re-writes the whole prefix.
      if (prewarmIdleMs > 0 && Date.now() - lastTurnEndedAt >= prewarmIdleMs) {
        startSpinner("warming cache…");
        await prewarmCache(turnDeps);
        stopSpinner();
      }
      startSpinner("thinking…");
      try {
        const stats = await runTurn(turnDeps, line);
        turns.push(stats);
        stopSpinner();
        const flushed = md.flush();
        if (flushed.length > 0) process.stdout.write(flushed + "\n");
        process.stdout.write("\n" + statsLine(stats) + "\n");
        for (const note of stats.notes) {
          process.stdout.write(dim(`⚠ ${note}`) + "\n");
        }
      } catch (err) {
        stopSpinner();
        md.reset();
        if (isAbort(err)) {
          process.stdout.write("\n" + interrupted() + "\n");
        } else {
          interrupt.disarm();
          rl.close();
          throw err;
        }
      } finally {
        interrupt.disarm();
        lastTurnEndedAt = Date.now();
      }
    }

    process.stdout.write(
      "\n" + dim(`session ${store.sessionId} saved · resume with -c`) + "\n",
    );
  } finally {
    interrupt.disarm();
    modeCtl.dispose();
    rl.close();
    process.stdout.write("\x1b[?25h");
  }
}
