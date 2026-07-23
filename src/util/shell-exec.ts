import { execFileSync } from "node:child_process";

interface ExecError {
  stdout?: string;
  stderr?: string;
  message?: string;
}

export function execShellPassthrough(cmd: string, cwd: string): void {
  try {
    const output = execFileSync("bash", ["-c", cmd], {
      cwd,
      encoding: "utf8",
      maxBuffer: 1 * 1024 * 1024,
      timeout: 30_000,
    });
    process.stdout.write(output.trimEnd() + "\n");
  } catch (err: unknown) {
    const e = err as ExecError;
    if (typeof e.stdout === "string" && e.stdout.trim())
      process.stdout.write(e.stdout.trim() + "\n");
    if (typeof e.stderr === "string" && e.stderr.trim())
      process.stderr.write(e.stderr.trim() + "\n");
    if (!e.stdout && !e.stderr)
      process.stderr.write((e.message ?? "command failed") + "\n");
  }
}
