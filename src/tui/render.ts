// Pure text formatters for the TUI. No I/O here — everything returns a
// string so it can be unit-tested without a terminal.

import { bold, cyan, dim, green, magenta, red, yellow } from "./ansi.js";
import type { TurnStats } from "../core/loop.js";
import { formatUsd } from "../core/cost.js";
import type { TodoItem } from "../tools/todo.js";

export function banner(model: string, sessionId: string, cwd: string): string {
  return [
    bold(cyan("stackpilot")) +
      dim(` · ${model} · session ${sessionId.slice(0, 8)}`),
    dim(`cwd ${cwd}`),
    dim("enter to send · esc interrupts · /help for commands"),
  ].join("\n");
}

export function helpText(): string {
  return [
    "/help          this help",
    "/todos         show the session todo list",
    "/usage         cumulative tokens + cost this session",
    "/compact       summarize the conversation, restart the stack from it",
    "/config        tools (multiselect) · auto-compact threshold",
    "/exit          quit",
  ].join("\n");
}

// The most human-relevant argument of a tool call, for one-line previews.
export function toolArgPreview(input: Record<string, unknown>): string {
  const arg =
    typeof input.command === "string"
      ? input.command
      : typeof input.file_path === "string"
        ? input.file_path
        : typeof input.pattern === "string"
          ? input.pattern
          : "";
  return arg.length > 80 ? `${arg.slice(0, 80)}…` : arg;
}

// One-line summary of a tool invocation, e.g.  ⏺ Bash(npm test)
export function toolStartLine(
  name: string,
  input: Record<string, unknown>,
): string {
  const shown = toolArgPreview(input);
  return `${magenta("⏺")} ${bold(name)}${shown ? dim(`(${shown})`) : ""}`;
}

// Message line for the clack permission select (plain text; clack styles it).
export function permissionLabel(
  name: string,
  input: Record<string, unknown>,
): string {
  const shown = toolArgPreview(input);
  return `Allow ${name}${shown ? `(${shown})` : ""}?`;
}

export function formatAge(deltaMs: number): string {
  const m = Math.floor(deltaMs / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function toolEndLine(output: string, isError: boolean): string {
  const first = (output.split("\n")[0] ?? "").slice(0, 100);
  const more = output.includes("\n")
    ? dim(` (+${output.split("\n").length - 1} lines)`)
    : "";
  return isError
    ? `  ${red("✗")} ${first}${more}`
    : `  ${green("✓")} ${dim(first)}${more}`;
}

export function statsLine(stats: TurnStats): string {
  const u = stats.usage;
  const totalIn =
    u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
  const hasCache =
    u.cache_read_input_tokens > 0 || u.cache_creation_input_tokens > 0;
  const pct =
    hasCache && totalIn > 0
      ? ` (${Math.round((u.cache_read_input_tokens / totalIn) * 100)}% cached)`
      : "";
  const cache = hasCache
    ? ` · cache ${u.cache_read_input_tokens}r/${u.cache_creation_input_tokens}w${pct}`
    : "";
  const cost = stats.costUsd !== null ? ` · ${formatUsd(stats.costUsd)}` : "";
  return dim(
    `${stats.requests} req · ${stats.toolCalls} tools · ${u.input_tokens} in${cache} · ${u.output_tokens} out${cost}`,
  );
}

export function usageSummary(turns: readonly TurnStats[]): string {
  const total = turns.reduce(
    (acc, t) => ({
      requests: acc.requests + t.requests,
      tools: acc.tools + t.toolCalls,
      input: acc.input + t.usage.input_tokens,
      output: acc.output + t.usage.output_tokens,
      cacheR: acc.cacheR + t.usage.cache_read_input_tokens,
      cacheW: acc.cacheW + t.usage.cache_creation_input_tokens,
      cost: acc.cost + (t.costUsd ?? 0),
      unpriced: acc.unpriced || t.costUsd === null,
    }),
    {
      requests: 0,
      tools: 0,
      input: 0,
      output: 0,
      cacheR: 0,
      cacheW: 0,
      cost: 0,
      unpriced: false,
    },
  );
  const costLine =
    turns.length === 0
      ? "n/a"
      : `${formatUsd(total.cost)}${total.unpriced ? " (some turns unpriced)" : ""}`;
  return [
    `turns          ${turns.length}`,
    `requests       ${total.requests}`,
    `tool calls     ${total.tools}`,
    `input tokens   ${total.input}`,
    `cache read     ${total.cacheR}`,
    `cache write    ${total.cacheW}`,
    `output tokens  ${total.output}`,
    `cost           ${costLine}`,
  ].join("\n");
}

export function todoBox(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return dim("(no todos)");
  const mark = {
    pending: dim("[ ]"),
    in_progress: yellow("[~]"),
    completed: green("[x]"),
  };
  return todos.map((t) => `${mark[t.status]} ${t.content}`).join("\n");
}

export function permissionPromptPlain(
  name: string,
  input: Record<string, unknown>,
): string {
  return `${yellow("?")} ${permissionLabel(name, input)} ${dim("[y/N/feedback]")} `;
}

export function interrupted(): string {
  return yellow("· interrupted (partial turn discarded)");
}

// --- Diff rendering --------------------------------------------------------

export function diffLine(line: string): string {
  if (line.startsWith("+")) return green(line);
  if (line.startsWith("-")) return red(line);
  if (line.startsWith("@@")) return cyan(line);
  if (line.startsWith("---") || line.startsWith("+++")) return bold(line);
  return dim(line);
}

export function renderDiff(patch: string, limit = 30): string {
  const lines = patch.split("\n");
  const head = lines.slice(0, limit);
  const suffix =
    lines.length > limit
      ? `\n${dim(`… ${lines.length - limit} more lines`)}`
      : "";
  return head.map(diffLine).join("\n") + suffix;
}

// --- Rich tool output ------------------------------------------------------

export function richToolOutput(
  toolName: string,
  output: string,
  isError: boolean,
): string {
  if (isError) {
    const first = output.split("\n").slice(0, 3).join("\n");
    return red(`✗ ${toolName}: ${first}`);
  }

  if (toolName === "Edit" || toolName === "Patch") {
    return renderDiff(output);
  }

  if (toolName === "Read" || toolName === "Grep") {
    const lines = output.split("\n");
    if (lines.length <= 15) return dim(output);
    const head = lines.slice(0, 12).join("\n");
    const tail = lines.slice(-3).join("\n");
    return `${dim(head)}\n${dim("  …")}\n${dim(tail)}\n${dim(`${lines.length} lines total`)}`;
  }

  if (toolName === "Write") {
    return green(`✓ ${output}`);
  }

  if (output.length > 500) {
    return dim(
      output.slice(0, 500) + `\n${dim(`… ${output.length - 500} more chars`)}`,
    );
  }

  return output;
}
