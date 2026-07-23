import { isCancel, multiselect, select, text } from "@clack/prompts";
import { dim } from "./ansi.js";
import {
  InterruptController,
  isAbort,
  restoreReadlineTty,
} from "./interrupt.js";
import {
  interrupted,
  helpText as renderHelpText,
  todoBox,
  usageSummary,
} from "./render.js";
import { runCompact } from "../core/compact.js";
import { formatUsd } from "../core/cost.js";
import { reduce } from "../core/reducer.js";
import { saveConfigPatch } from "../config.js";
import type { SessionStore } from "../session/store.js";
import type { Registry } from "../tools/index.js";
import type { TransportConfig } from "../transport/anthropic.js";
import type { ModelPricing } from "../config.js";
import type { HookConfig } from "../core/hooks.js";
import type { TurnStats } from "../core/loop.js";
import { modeLine, nextMode, parseMode, type ModeState } from "../core/mode.js";

export interface CommandContext {
  store: SessionStore;
  registry: Registry;
  config: TransportConfig;
  system: string;
  pricing?: Record<string, ModelPricing>;
  interrupt: InterruptController;
  stream: ReturnType<
    typeof import("../transport/anthropic.js").streamWithRetry
  >;
  hooks?: {
    preCompact?: HookConfig;
    postCompact?: HookConfig;
  };
  turns: TurnStats[];
  autoCompactState: { value: number };
  mode: ModeState;
  startSpinner: (label: string) => void;
  stopSpinner: () => void;
}

export async function doCompact(
  reason: "manual" | "auto",
  ctx: CommandContext,
): Promise<void> {
  const { interrupt, startSpinner, stopSpinner } = ctx;
  interrupt.reset();
  interrupt.arm();
  startSpinner("compacting…");
  try {
    const res = await runCompact({
      store: ctx.store,
      registry: ctx.registry,
      config: ctx.config,
      system: ctx.system,
      pricing: ctx.pricing,
      signal: interrupt.signal,
      stream: ctx.stream,
      hooks: ctx.hooks,
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

export async function doConfig(ctx: CommandContext): Promise<void> {
  const { registry, autoCompactState, turns, store } = ctx;
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
    if (what === "tools") await configTools(registry, turns, store);
    else await configThreshold(autoCompactState);
  } finally {
    restoreReadlineTty();
  }
}

async function configTools(
  registry: Registry,
  turns: TurnStats[],
  store: SessionStore,
): Promise<void> {
  const chosen = await multiselect({
    message:
      "Tools sent to the model (schema presence — part of the cache prefix)",
    options: registry.defs.map((d) => ({
      value: d.name,
      label: d.name,
      hint: d.runPermitless ? "no prompt" : "asks permission",
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

async function configThreshold(autoCompactState: {
  value: number;
}): Promise<void> {
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

export function handleSlashCommand(
  line: string,
  ctx: CommandContext,
): "continue" | "break" | "handled" {
  if (line === "/exit" || line === "/quit") return "break";
  if (line === "/help") process.stdout.write(renderHelpText() + "\n");
  else if (line === "/todos")
    process.stdout.write(todoBox(ctx.registry.todoState.todos) + "\n");
  else if (line === "/usage")
    process.stdout.write(usageSummary(ctx.turns) + "\n");
  else if (line === "/compact") void doCompact("manual", ctx);
  else if (line === "/config") void doConfig(ctx);
  else if (line === "/mode" || line.startsWith("/mode ")) {
    const arg = line.slice("/mode".length).trim();
    ctx.mode.current = arg
      ? (parseMode(arg) ?? ctx.mode.current)
      : nextMode(ctx.mode.current);
    process.stdout.write(modeLine(ctx.mode.current) + "\n");
  } else
    process.stdout.write(dim(`unknown command: ${line} (try /help)`) + "\n");
  return "handled";
}
