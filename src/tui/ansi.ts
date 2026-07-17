// Minimal ANSI styling. No dependencies; disabled automatically when the
// stream is not a TTY (or NO_COLOR is set).

const enabled =
  process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

function wrap(open: number, close: number): (s: string) => string {
  return (s) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
}

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const italic = wrap(3, 23);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);
export const magenta = wrap(35, 39);

export const CLEAR_LINE = "\r\x1b[2K";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];
