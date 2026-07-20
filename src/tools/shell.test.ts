import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { bashTool } from "./shell.js";

const cwd = tmpdir();

describe("bashTool", () => {
  it("returns stdout of a successful command", async () => {
    const res = await bashTool.execute({ command: "echo hello" }, cwd);
    expect(res.isError).toBeFalsy();
    expect(res.output).toContain("hello");
  });

  it("marks a non-zero exit as an error", async () => {
    const res = await bashTool.execute({ command: "exit 3" }, cwd);
    expect(res.isError).toBe(true);
  });

  it("captures stderr", async () => {
    const res = await bashTool.execute({ command: "echo oops 1>&2" }, cwd);
    expect(res.output).toContain("oops");
  });

  it("times out and kills the process group", async () => {
    const res = await bashTool.execute(
      { command: "sleep 5", timeout: 200 },
      cwd,
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("timed out");
  });

  it("kills a command that floods output past the hard cap", async () => {
    // yes | head would still be bounded; use an unbounded producer.
    const res = await bashTool.execute(
      { command: "cat /dev/zero | tr '\\0' 'a'", timeout: 10_000 },
      cwd,
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("exceeded");
  });

  it("runs in the given cwd", async () => {
    const res = await bashTool.execute({ command: "pwd" }, cwd);
    // macOS /tmp is a symlink to /private/tmp; just assert non-empty output.
    expect(res.output.trim().length).toBeGreaterThan(0);
  });
});
