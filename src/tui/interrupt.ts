import { emitKeypressEvents } from "node:readline";
import process from "node:process";

export class InterruptController {
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

// Intercepts Tab at the idle prompt to cycle the session mode. Uses the same
// raw-keypress channel as InterruptController; only acts while armed (i.e. the
// prompt is idle and waiting for a line), so it never fights readline's own
// Tab/completer handling during a turn.
export class ModeController {
  private active = false;
  private readonly onKeypress = (
    _str: string,
    key: { name?: string } | undefined,
  ): void => {
    if (this.active && key?.name === "tab") this.onTab();
  };

  constructor(private readonly onTab: () => void) {}

  arm(): void {
    if (this.active) return;
    this.active = true;
    emitKeypressEvents(process.stdin);
    process.stdin.on("keypress", this.onKeypress);
  }

  disarm(): void {
    this.active = false;
  }

  dispose(): void {
    this.active = false;
    process.stdin.off("keypress", this.onKeypress);
  }
}

export function restoreReadlineTty(): void {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
}

export function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
