import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { logHookResult, runHook, type HookResult } from "./hooks.js";

const cwd = tmpdir();

describe("runHook", () => {
  it("returns null when no config is provided", async () => {
    expect(await runHook("pre_tool", undefined, "sid", cwd)).toBeNull();
  });

  it("returns null for an empty command array", async () => {
    expect(
      await runHook("pre_tool", { command: [], timeoutMs: 1000 }, "sid", cwd),
    ).toBeNull();
  });

  it("captures stdout and a zero exit code", async () => {
    const res = await runHook(
      "pre_tool",
      { command: "echo hello-hook", timeoutMs: 5000 },
      "sid",
      cwd,
    );
    expect(res).not.toBeNull();
    expect(res![0]!.stdout).toBe("hello-hook");
    expect(res![0]!.exitCode).toBe(0);
    expect(res![0]!.timedOut).toBe(false);
  });

  it("reports a non-zero exit code", async () => {
    const res = await runHook(
      "post_tool",
      { command: "exit 7", timeoutMs: 5000 },
      "sid",
      cwd,
    );
    expect(res![0]!.exitCode).toBe(7);
  });

  it("runs every command in an array, in order", async () => {
    const res = await runHook(
      "session_start",
      { command: ["echo one", "echo two"], timeoutMs: 5000 },
      "sid",
      cwd,
    );
    expect(res).toHaveLength(2);
    expect(res![0]!.stdout).toBe("one");
    expect(res![1]!.stdout).toBe("two");
  });

  it("passes the JSON context on stdin", async () => {
    // The hook echoes back stdin; assert the context fields are present.
    const res = await runHook(
      "pre_tool",
      { command: "cat", timeoutMs: 5000 },
      "session-xyz",
      cwd,
      "Bash",
      { command: "ls" },
    );
    const ctx = JSON.parse(res![0]!.stdout) as Record<string, unknown>;
    expect(ctx.hook).toBe("pre_tool");
    expect(ctx.sessionId).toBe("session-xyz");
    expect(ctx.tool).toBe("Bash");
  });

  it("marks a command that exceeds the timeout as timedOut", async () => {
    const res = await runHook(
      "pre_tool",
      { command: "sleep 5", timeoutMs: 200 },
      "sid",
      cwd,
    );
    expect(res![0]!.timedOut).toBe(true);
  });
});

describe("logHookResult", () => {
  const base: HookResult = {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
  };

  it("returns stdout and logs it when present", () => {
    const logs: string[] = [];
    const out = logHookResult(
      "pre_tool",
      { ...base, stdout: "context line" },
      (m) => logs.push(m),
    );
    expect(out).toBe("context line");
    expect(logs.join("\n")).toContain("context line");
  });

  it("logs a non-zero exit and returns null (no stdout)", () => {
    const logs: string[] = [];
    const out = logHookResult(
      "post_tool",
      { ...base, exitCode: 2, stderr: "boom" },
      (m) => logs.push(m),
    );
    expect(out).toBeNull();
    expect(logs.join("\n")).toContain("exited 2");
  });

  it("reports a timeout", () => {
    const logs: string[] = [];
    logHookResult("pre_tool", { ...base, timedOut: true }, (m) => logs.push(m));
    expect(logs.join("\n")).toContain("timed out");
  });
});
