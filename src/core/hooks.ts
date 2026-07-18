import { execFile } from "node:child_process";

export type HookPoint =
  "pre_tool" | "post_tool" | "session_start" | "session_end";

export interface HookConfig {
  command: string;
  timeoutMs: number;
}

export interface HookContext {
  hook: HookPoint;
  sessionId: string;
  cwd: string;
  timestamp: string;
  tool?: string;
  input?: Record<string, unknown>;
}

export interface HookResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 5000;

export async function runHook(
  hook: HookPoint,
  config: HookConfig | undefined,
  sessionId: string,
  cwd: string,
  tool?: string,
  input?: Record<string, unknown>,
): Promise<HookResult | null> {
  if (!config || !config.command) return null;

  const ctx: HookContext = {
    hook,
    sessionId,
    cwd,
    timestamp: new Date().toISOString(),
  };
  if (tool !== undefined) ctx.tool = tool;
  if (input !== undefined) ctx.input = input;

  const stdin = JSON.stringify(ctx);
  const timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
  const env = {
    ...process.env,
    STACKPILOT_HOOK: hook,
    ...(tool ? { STACKPILOT_TOOL: tool } : {}),
  };

  return new Promise<HookResult>((resolve) => {
    const child = execFile(
      config.command,
      [],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env,
      },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          timedOut: err?.killed ?? false,
        });
      },
    );

    if (child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

export function logHookResult(
  hook: HookPoint,
  result: HookResult,
  log: (msg: string) => void,
): string | null {
  const label = `[hook:${hook}]`;
  if (result.timedOut) {
    log(`${label} timed out (${result.exitCode})`);
    return null;
  }
  if (result.exitCode !== 0) {
    log(`${label} exited ${result.exitCode}: ${result.stderr.slice(0, 200)}`);
  }
  if (result.stdout.length > 0) {
    log(`${label} ${result.stdout.slice(0, 200)}`);
    return result.stdout;
  }
  return null;
}
