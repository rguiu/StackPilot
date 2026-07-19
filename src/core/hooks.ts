import { execFile } from "node:child_process";

export type HookPoint =
  | "pre_tool"
  | "post_tool"
  | "session_start"
  | "session_end"
  | "pre_compact"
  | "post_compact";

export interface HookConfig {
  command: string | string[];
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

function commands(config: HookConfig): string[] {
  return Array.isArray(config.command) ? config.command : [config.command];
}

async function runOne(
  command: string,
  ctx: HookContext,
  cwd: string,
  timeoutMs: number,
): Promise<HookResult> {
  const env = {
    ...process.env,
    STACKPILOT_HOOK: ctx.hook,
    ...(ctx.tool ? { STACKPILOT_TOOL: ctx.tool } : {}),
  };

  return new Promise<HookResult>((resolve) => {
    const child = execFile(
      command,
      [],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env,
        shell: true,
      },
      (err, stdout, stderr) => {
        resolve({
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: err
            ? typeof (err as { code?: unknown }).code === "number"
              ? (err as { code: number }).code
              : 1
            : 0,
          timedOut:
            err != null && (err as { killed?: boolean }).killed === true,
        });
      },
    );

    if (child.stdin) {
      child.stdin.write(JSON.stringify(ctx));
      child.stdin.end();
    }
  });
}

export async function runHook(
  hook: HookPoint,
  config: HookConfig | undefined,
  sessionId: string,
  cwd: string,
  tool?: string,
  input?: Record<string, unknown>,
): Promise<HookResult[] | null> {
  if (!config) return null;
  const cmds = commands(config);
  if (cmds.length === 0) return null;

  const ctx: HookContext = {
    hook,
    sessionId,
    cwd,
    timestamp: new Date().toISOString(),
  };
  if (tool !== undefined) ctx.tool = tool;
  if (input !== undefined) ctx.input = input;

  const timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;

  const results: HookResult[] = [];
  for (const cmd of cmds) {
    results.push(await runOne(cmd, ctx, cwd, timeoutMs));
  }
  return results;
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
