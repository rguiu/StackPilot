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

export function restoreReadlineTty(): void {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
}

export function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
