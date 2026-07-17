// Interactive TUI app. Inline rendering: the transcript lives in normal
// terminal scrollback; between turns readline owns the input line (history
// for free). During a turn we own stdin in raw mode so Esc can abort.

import { createInterface, type Interface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import process from "node:process";
import { CLEAR_LINE, SPINNER_FRAMES, cyan, dim } from "./ansi.js";
import {
  banner,
  helpText,
  interrupted,
  permissionPrompt,
  statsLine,
  todoBox,
  toolEndLine,
  toolStartLine,
  usageSummary,
} from "./render.js";
import { runTurn, type TurnIO, type TurnStats } from "../core/loop.js";
import type { SessionStore } from "../session/store.js";
import type { Registry } from "../tools/index.js";
import type { TransportConfig } from "../transport/anthropic.js";
import { streamMessage } from "../transport/anthropic.js";

export interface AppDeps {
  store: SessionStore;
  registry: Registry;
  config: TransportConfig;
  system: string;
}

class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;

  start(label: string): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      process.stderr.write(
        `${CLEAR_LINE}${cyan(SPINNER_FRAMES[this.frame]!)} ${dim(label)}`,
      );
    }, 80);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    process.stderr.write(CLEAR_LINE);
  }
}

// Owns Esc detection during a turn. Raw mode is enabled only while a turn is
// running and released for readline prompts (permission questions, input).
class InterruptController {
  private controller = new AbortController();
  private active = false;
  private readonly onKeypress = (
    _str: string,
    key: { name?: string } | undefined,
  ): void => {
    if (key?.name === "escape") this.controller.abort();
  };

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  arm(): void {
    if (this.active) return;
    this.active = true;
    emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.on("keypress", this.onKeypress);
    process.stdin.resume();
  }

  // NOTE: never pause stdin here. readline owns the stream between turns; a
  // paused TTY stream stops ref'ing the event loop and node exits mid-await
  // on the next question(). We only detach our listener and drop raw mode.
  disarm(): void {
    if (!this.active) return;
    this.active = false;
    process.stdin.off("keypress", this.onKeypress);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  }

  reset(): void {
    this.controller = new AbortController();
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export async function runApp(deps: AppDeps): Promise<void> {
  const { store, registry, config, system } = deps;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const spinner = new Spinner();
  const interrupt = new InterruptController();
  const turns: TurnStats[] = [];
  let streamedAnything = false;

  const io: TurnIO = {
    onText: (delta) => {
      if (!streamedAnything) {
        spinner.stop();
        streamedAnything = true;
        process.stdout.write("\n");
      }
      process.stdout.write(delta);
    },
    onToolStart: (name, input) => {
      spinner.stop();
      process.stdout.write(`\n\n${toolStartLine(name, input)}\n`);
      streamedAnything = false;
      spinner.start("running tool…");
    },
    onToolEnd: (_name, output, isError) => {
      spinner.stop();
      process.stdout.write(`${toolEndLine(output, isError)}\n`);
      spinner.start("thinking…");
    },
    permit: async (name, input) => {
      spinner.stop();
      interrupt.disarm(); // hand stdin back to readline for the question
      const answer = await rl.question(`\n${permissionPrompt(name, input)}`);
      interrupt.arm();
      return answer.trim().toLowerCase().startsWith("y");
    },
  };

  console.log(banner(config.model, store.sessionId, process.cwd()));

  for (;;) {
    let line: string;
    try {
      line = (await rl.question(`\n${cyan("›")} `)).trim();
    } catch {
      break; // stdin closed (Ctrl+D) — exit cleanly, session is already saved
    }
    if (line === "") continue;

    if (line.startsWith("/")) {
      if (line === "/exit" || line === "/quit") break;
      else if (line === "/help") console.log(helpText());
      else if (line === "/todos")
        console.log(todoBox(registry.todoState.todos));
      else if (line === "/usage") console.log(usageSummary(turns));
      else console.log(dim(`unknown command: ${line} (try /help)`));
      continue;
    }

    interrupt.reset();
    interrupt.arm();
    streamedAnything = false;
    spinner.start("thinking…");
    try {
      const stats = await runTurn(
        {
          store,
          registry,
          config,
          system,
          io,
          signal: interrupt.signal,
          stream: streamMessage,
        },
        line,
      );
      turns.push(stats);
      spinner.stop();
      process.stdout.write(`\n\n${statsLine(stats)}\n`);
    } catch (err) {
      spinner.stop();
      if (isAbort(err)) {
        process.stdout.write(`\n${interrupted()}\n`);
      } else {
        interrupt.disarm();
        rl.close();
        throw err; // unrecoverable — surface it, don't loop on a broken state
      }
    } finally {
      interrupt.disarm();
    }
  }

  rl.close();
  console.log(dim(`session ${store.sessionId} saved · resume with -c`));
}
