// TUI: readline for input, stdout for streaming output. Bottom-bar
// separator + status line between turns. Esc via InterruptController.

import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import process from "node:process";
import { isCancel, multiselect, select, text } from "@clack/prompts";
import { SPINNER_FRAMES, cyan, dim } from "./ansi.js";
import { MarkdownRenderer } from "./markdown.js";
import {
  helpText,
  interrupted,
  permissionLabel,
  richToolOutput,
  statsLine,
  todoBox,
  usageSummary,
} from "./render.js";
import { runTurn, type TurnIO, type TurnStats } from "../core/loop.js";
import { runCompact } from "../core/compact.js";
import { CacheLedger } from "../core/cache.js";
import { formatUsd } from "../core/cost.js";
import { reduce } from "../core/reducer.js";
import { saveConfigPatch, type ModelPricing } from "../config.js";
import type { SessionStore } from "../session/store.js";
import type { Registry } from "../tools/index.js";
import type { TransportConfig } from "../transport/anthropic.js";
import { streamWithRetry } from "../transport/anthropic.js";
import type { HookConfig } from "../core/hooks.js";
import type { SessionState } from "../core/policies.js";

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
  };
  sessionState?: SessionState;
  maxToolResultChars?: number;
}

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
    process.stdin.on("keypress", this.onKeypress);
    process.stdin.resume();
  }

  disarm(): void {
    if (!this.active) return;
    this.active = false;
    process.stdin.off("keypress", this.onKeypress);
  }

  reset(): void {
    this.controller = new AbortController();
  }

  abort(): void {
    this.controller.abort();
  }
}

function restoreReadlineTty(): void {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

export async function runApp(deps: AppDeps): Promise<void> {
  const { store, registry, config, system, pricing } = deps;
  const stream = streamWithRetry(config);
  const autoCompactState = { value: deps.autoCompactAtTokens ?? 0 };
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const interrupt = new InterruptController();
  const turns: TurnStats[] = [];
  const sessionAllow = new Set<string>();
  const ledger = new CacheLedger();
  const md = new MarkdownRenderer();
  let streamedAnything = false;

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
      process.stdout.write(delta);
    },
    onToolStart: (name, input) => {
      stopSpinner();
      const flushed = md.flush();
      if (flushed.length > 0) process.stdout.write(flushed + "\n");
      md.reset();
      const brief = JSON.stringify(input);
      process.stdout.write(
        `\n${cyan("⏺")} ${name} ${brief.length > 120 ? brief.slice(0, 120) + "…" : brief}\n`,
      );
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

  const totalCost = turns.reduce((sum, t) => sum + (t.costUsd ?? 0), 0);
  const costStr = pricing ? ` ${formatUsd(totalCost)}` : "";
  process.stdout.write(
    [
      `${cyan("stackpilot")} ${dim("·")} ${config.model} ${dim("·")} session ${store.sessionId.slice(0, 8)}`,
      dim(`cwd ${deps.cwd}${costStr}`),
      dim("esc interrupts · ! for shell · /help for commands"),
      "",
    ].join("\n"),
  );

  async function doCompact(reason: "manual" | "auto"): Promise<void> {
    interrupt.reset();
    interrupt.arm();
    startSpinner("compacting…");
    try {
      const res = await runCompact({
        store,
        registry,
        config,
        system,
        pricing,
        signal: interrupt.signal,
        stream,
      });
      stopSpinner();
      if (!res) {
        process.stdout.write(dim("nothing to compact") + "\n");
        return;
      }
      const cost = res.costUsd !== null ? ` · ${formatUsd(res.costUsd)}` : "";
      process.stdout.write(
        dim(
          `✂ compacted (${reason}): ${res.totalMessages} messages → ${res.summaryChars}-char summary${cost}`,
        ) + "\n",
      );
    } catch (err) {
      stopSpinner();
      if (isAbort(err)) {
        process.stdout.write("\n" + interrupted() + "\n");
        return;
      }
      throw err;
    } finally {
      interrupt.disarm();
    }
  }

  async function doConfig(): Promise<void> {
    try {
      const what = await select({
        message: "Configure what?",
        options: [
          {
            value: "tools",
            label: `Tools (${registry.enabledNames().length}/${registry.defs.length} enabled)`,
          },
          {
            value: "compact",
            label: `Auto-compact threshold (${autoCompactState.value === 0 ? "off" : autoCompactState.value})`,
          },
        ],
      });
      if (isCancel(what)) return;
      if (what === "tools") await configTools();
      else await configThreshold();
    } finally {
      restoreReadlineTty();
    }
  }

  async function configTools(): Promise<void> {
    const chosen = await multiselect({
      message:
        "Tools sent to the model (schema presence — part of the cache prefix)",
      options: registry.defs.map((d) => ({
        value: d.name,
        label: d.name,
        hint: d.runPermitless ? "read-only" : "mutating",
      })),
      initialValues: registry.enabledNames(),
      required: false,
    });
    if (isCancel(chosen)) return;
    const names = chosen;
    const requestsSent = turns.some((t) => t.requests > 0);

    if (!requestsSent) {
      const scope = await select({
        message: "Apply how?",
        options: [
          { value: "session", label: "This session only" },
          { value: "permanent", label: "Permanently (save to config file)" },
        ],
      });
      if (isCancel(scope)) return;
      registry.setEnabled(names);
      store.append({
        type: "config",
        parentUuid: reduce(store.all()).leafUuid,
        meta: { tools: names },
      });
      if (scope === "permanent") {
        const path = saveConfigPatch({ enabledTools: names }, process.env);
        process.stdout.write(dim(`saved to ${path}`) + "\n");
      }
      process.stdout.write(
        dim(`tools enabled: ${names.join(", ") || "(none)"}`) + "\n",
      );
    } else {
      const scope = await select({
        message: "Prefix already established — tool changes apply next session",
        options: [
          { value: "permanent", label: "Save as default for future sessions" },
          { value: "cancel", label: "Cancel" },
        ],
      });
      if (isCancel(scope) || scope === "cancel") return;
      const path = saveConfigPatch({ enabledTools: names }, process.env);
      process.stdout.write(
        dim(`saved to ${path} — takes effect next session`) + "\n",
      );
    }
  }

  async function configThreshold(): Promise<void> {
    const raw = await text({
      message: "Auto-compact when last request input exceeds (tokens, 0 = off)",
      initialValue: String(autoCompactState.value),
      validate: (v) =>
        /^\d+$/.test((v ?? "").trim())
          ? undefined
          : "enter a non-negative integer",
    });
    if (isCancel(raw)) return;
    const value = parseInt(raw.trim(), 10);
    const scope = await select({
      message: "Apply how?",
      options: [
        { value: "session", label: "This session only (applies immediately)" },
        { value: "permanent", label: "Permanently (save + apply now)" },
      ],
    });
    if (isCancel(scope)) return;
    autoCompactState.value = value;
    if (scope === "permanent") {
      const path = saveConfigPatch({ autoCompactAtTokens: value }, process.env);
      process.stdout.write(dim(`saved to ${path}`) + "\n");
    }
    process.stdout.write(
      dim(`auto-compact: ${value === 0 ? "off" : `at ${value} tokens`}`) + "\n",
    );
  }

  try {
    for (;;) {
      // Bottom-bar: separator + status before each prompt
      if (turns.length > 0) {
        const last = turns[turns.length - 1];
        if (last) process.stdout.write("\n");
      } else {
        process.stdout.write("\n");
      }

      let line: string;
      try {
        line = (await rl.question(`${cyan("›")} `)).trim();
      } catch {
        break;
      }
      if (line === "") continue;

      if (line.startsWith("!")) {
        const cmd = line.slice(1).trim();
        if (cmd) {
          const { execFileSync } = await import("node:child_process");
          try {
            const output = execFileSync("bash", ["-c", cmd], {
              cwd: deps.cwd,
              encoding: "utf8",
              maxBuffer: 1 * 1024 * 1024,
              timeout: 30_000,
            });
            process.stdout.write(output.trimEnd() + "\n");
          } catch (err: unknown) {
            const e = err as {
              stdout?: string;
              stderr?: string;
              message?: string;
            };
            if (typeof e.stdout === "string" && e.stdout.trim())
              process.stdout.write(e.stdout.trim() + "\n");
            if (typeof e.stderr === "string" && e.stderr.trim())
              process.stderr.write(e.stderr.trim() + "\n");
            if (!e.stdout && !e.stderr)
              process.stderr.write((e.message ?? "command failed") + "\n");
          }
        }
        continue;
      }

      if (line.startsWith("/")) {
        if (line === "/exit" || line === "/quit") break;
        else if (line === "/help") process.stdout.write(helpText() + "\n");
        else if (line === "/todos")
          process.stdout.write(todoBox(registry.todoState.todos) + "\n");
        else if (line === "/usage")
          process.stdout.write(usageSummary(turns) + "\n");
        else if (line === "/compact") await doCompact("manual");
        else if (line === "/config") await doConfig();
        else
          process.stdout.write(
            dim(`unknown command: ${line} (try /help)`) + "\n",
          );
        continue;
      }

      interrupt.reset();
      interrupt.arm();
      streamedAnything = false;
      md.reset();
      startSpinner("thinking…");
      try {
        const stats = await runTurn(
          {
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
          },
          line,
        );
        turns.push(stats);
        stopSpinner();
        const flushed = md.flush();
        if (flushed.length > 0) process.stdout.write(flushed + "\n");
        process.stdout.write("\n" + statsLine(stats) + "\n");
        for (const note of stats.notes) {
          process.stdout.write(dim(`⚠ ${note}`) + "\n");
        }
        if (
          autoCompactState.value > 0 &&
          stats.lastRequestInputTokens >= autoCompactState.value
        ) {
          process.stdout.write(
            dim(
              `context ${stats.lastRequestInputTokens} tokens ≥ ${autoCompactState.value} threshold — auto-compacting`,
            ) + "\n",
          );
          await doCompact("auto");
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
      }
    }

    process.stdout.write(
      "\n" + dim(`session ${store.sessionId} saved · resume with -c`) + "\n",
    );
  } finally {
    interrupt.disarm();
    rl.close();
    process.stdout.write("\x1b[?25h"); // restore cursor visibility
  }
}
