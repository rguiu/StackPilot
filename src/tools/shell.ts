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

export const bashTool: ToolDef = {
  name: "Bash",
  description:
    "Run a shell command in the working directory. Returns combined stdout/stderr.",
  readOnly: false,
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
    const timeoutMs = Math.min(
      typeof input.timeout === "number" ? input.timeout : DEFAULT_TIMEOUT_MS,
      600_000,
    );
    return new Promise<ToolResult>((resolvePromise) => {
      const child = spawn("bash", ["-c", command], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (out += d.toString()));
      child.on("error", (err) => {
        clearTimeout(timer);
        resolvePromise({ output: err.message, isError: true });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolvePromise({
            output: `${truncate(out, MAX_OUTPUT)}\n[timed out after ${timeoutMs}ms]`,
            isError: true,
          });
        } else {
          resolvePromise({
            output: truncate(out, MAX_OUTPUT) || "(no output)",
            isError: code !== 0,
          });
        }
      });
    });
  },
};
