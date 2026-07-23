// Session operating mode. Gates tool execution and drives the TUI indicator.
// Build: writes allowed (with the usual permission prompts).
// Plan:  read-only — every write tool is refused before it runs, and the
//        model is told to produce a plan rather than act.

import { green, blue, dim } from "../tui/ansi.js";

export type SessionMode = "build" | "plan";

export const MODE_CYCLE: readonly SessionMode[] = ["build", "plan"];

// Shared mutable holder threaded by reference into the loop and I/O layers so
// a Tab press between turns changes what the next turn sees.
export interface ModeState {
  current: SessionMode;
}

export function createModeState(initial: SessionMode = "build"): ModeState {
  return { current: initial };
}

export function nextMode(mode: SessionMode): SessionMode {
  const i = MODE_CYCLE.indexOf(mode);
  return MODE_CYCLE[(i + 1) % MODE_CYCLE.length] ?? "build";
}

export function parseMode(value: string): SessionMode | undefined {
  const v = value.trim().toLowerCase();
  return v === "build" || v === "plan" ? v : undefined;
}

const DOT = "●";

// Color-coded indicator shown below the input box.
export function modeLine(mode: SessionMode): string {
  const label = mode === "plan" ? blue(`${DOT} Plan`) : green(`${DOT} Build`);
  return `${dim("mode:")} ${label} ${dim("· tab to switch")}`;
}

// Per-turn system reminder injected ahead of the user's message.
export function modeReminder(mode: SessionMode): string | null {
  if (mode !== "plan") return null;
  return (
    "<system-reminder>\n" +
    "Mode: PLAN (read-only). Do not modify files or run commands that change " +
    "state. Investigate and produce a concrete plan, then stop and present it. " +
    "Any write tool (Write/Edit/Patch/Bash/Agent) will be refused.\n" +
    "</system-reminder>"
  );
}
