import { describe, expect, it } from "vitest";
import { parseArgs, versionString } from "./main.js";

describe("parseArgs", () => {
  it("defaults to an interactive, non-version run", () => {
    const a = parseArgs([]);
    expect(a).toEqual({
      continue_: false,
      yolo: false,
      json: false,
      version: false,
    });
  });

  it("parses -p / --print with a value", () => {
    expect(parseArgs(["-p", "hello"]).prompt).toBe("hello");
    expect(parseArgs(["--print", "hi there"]).prompt).toBe("hi there");
  });

  it("parses -v and --version", () => {
    expect(parseArgs(["-v"]).version).toBe(true);
    expect(parseArgs(["--version"]).version).toBe(true);
  });

  it("parses flags and --tools list", () => {
    const a = parseArgs(["--yolo", "--json", "--tools", "Read, Bash ,Grep"]);
    expect(a.yolo).toBe(true);
    expect(a.json).toBe(true);
    expect(a.tools).toEqual(["Read", "Bash", "Grep"]);
  });
});

describe("versionString", () => {
  it("reports the package version (with a commit when in a git checkout)", () => {
    const v = versionString();
    expect(v).toMatch(/^stackpilot \d+\.\d+\.\d+( \([0-9a-f]{7,}\))?$/);
  });
});
