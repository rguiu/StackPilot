// Bash tool: one command per call in the session cwd. Deliberately not a
// persistent shell in P1 (KISS); timeout + output cap enforced.

import { spawn } from "node:child_process";
import {
  truncate,
  requireString,
  type ToolDef,
  type ToolResult,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 30_000;

// Kill the child's entire process group (negative pid). With detached:true the
// child is its own group leader, so this reaps `bash -c` grandchildren too.
// Falls back to killing just the child if the group signal fails.
function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

export const bashTool: ToolDef = {
  name: "Bash",
  description:
    "Run a shell command in the working directory. Returns combined stdout/stderr.",
  runPermitless: false,
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout: { type: "number", description: "ms, max 600000" },
    },
    required: ["command"],
  },
  async execute(input, cwd): Promise<ToolResult> {
    const command = requireString(input, "command");
    const requested =
      typeof input.timeout === "number" && input.timeout > 0
        ? input.timeout
        : DEFAULT_TIMEOUT_MS;
    const timeoutMs = Math.min(requested, 600_000);
    return new Promise<ToolResult>((resolvePromise) => {
      // detached:true puts the child in its own process group so we can
      // SIGKILL the whole group on timeout — otherwise `bash -c` grandchildren
      // (pipelines, backgrounded jobs) survive and orphan.
      const child = spawn("bash", ["-c", command], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let out = "";
      // Cap accumulation DURING streaming so a runaway command (e.g.
      // `cat /dev/urandom`) can't OOM us before the close handler runs. We
      // keep a little slack past MAX_OUTPUT so truncate() can report totals.
      const HARD_CAP = MAX_OUTPUT * 2;
      let capped = false;
      const append = (d: Buffer): void => {
        if (capped) return;
        out += d.toString();
        if (out.length >= HARD_CAP) {
          capped = true;
          out = out.slice(0, HARD_CAP);
          killGroup(child.pid, "SIGKILL");
        }
      };
      let timedOut = false;
      let settled = false;
      const finish = (result: ToolResult): void => {
        if (settled) return;
        settled = true;
        resolvePromise(result);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child.pid, "SIGKILL");
      }, timeoutMs);
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      child.on("error", (err) => {
        clearTimeout(timer);
        finish({ output: err.message, isError: true });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          finish({
            output: `${truncate(out, MAX_OUTPUT)}\n[timed out after ${timeoutMs}ms]`,
            isError: true,
          });
        } else if (capped) {
          finish({
            output: `${truncate(out, MAX_OUTPUT)}\n[output exceeded ${HARD_CAP} chars — command killed]`,
            isError: true,
          });
        } else {
          finish({
            output: truncate(out, MAX_OUTPUT) || "(no output)",
            isError: code !== 0,
          });
        }
      });
    });
  },
};
