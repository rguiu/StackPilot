// Pure text formatters for the TUI. No I/O here — everything returns a
// string so it can be unit-tested without a terminal.

import { bold, cyan, dim, green, magenta, red, yellow } from "./ansi.js";
import type { TurnStats } from "../core/loop.js";
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
    "/usage         cumulative token usage this session",
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
  const cache =
    u.cache_read_input_tokens > 0 || u.cache_creation_input_tokens > 0
      ? ` · cache ${u.cache_read_input_tokens}r/${u.cache_creation_input_tokens}w`
      : "";
  return dim(
    `${stats.requests} req · ${stats.toolCalls} tools · ${u.input_tokens} in${cache} · ${u.output_tokens} out`,
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
    }),
    { requests: 0, tools: 0, input: 0, output: 0, cacheR: 0, cacheW: 0 },
  );
  return [
    `turns          ${turns.length}`,
    `requests       ${total.requests}`,
    `tool calls     ${total.tools}`,
    `input tokens   ${total.input}`,
    `cache read     ${total.cacheR}`,
    `cache write    ${total.cacheW}`,
    `output tokens  ${total.output}`,
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
  return `${yellow("?")} ${permissionLabel(name, input)} ${dim("[y/N]")} `;
}

export function interrupted(): string {
  return yellow("· interrupted (partial turn discarded)");
}
