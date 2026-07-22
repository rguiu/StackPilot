import { describe, expect, it } from "vitest";
import { absPath, resolveToolPath } from "./path.js";
import { ToolInputError } from "../tools/types.js";

describe("absPath", () => {
  it("returns absolute paths unchanged", () => {
    expect(absPath("/cwd", "/etc/hosts")).toBe("/etc/hosts");
  });
  it("resolves relative paths against cwd", () => {
    expect(absPath("/cwd", "sub/file.ts")).toBe("/cwd/sub/file.ts");
  });
});

describe("workspace confinement (off by default)", () => {
  it("allows any path when no root is set", () => {
    expect(resolveToolPath("/proj", "/etc/passwd", undefined)).toBe(
      "/etc/passwd",
    );
  });
});

describe("workspace confinement (enabled)", () => {
  const root = "/proj";

  it("allows paths inside the root", () => {
    expect(resolveToolPath("/proj", "src/a.ts", root)).toBe("/proj/src/a.ts");
    expect(resolveToolPath("/proj", "/proj/deep/b.ts", root)).toBe(
      "/proj/deep/b.ts",
    );
  });

  it("allows the root itself", () => {
    expect(resolveToolPath("/proj", ".", root)).toBe("/proj");
  });

  it("rejects an absolute path outside the root", () => {
    expect(() => resolveToolPath("/proj", "/etc/passwd", root)).toThrow(
      ToolInputError,
    );
  });

  it("rejects a ../ traversal that escapes the root", () => {
    expect(() => resolveToolPath("/proj", "../secrets/key", root)).toThrow(
      ToolInputError,
    );
  });

  it("rejects a sibling directory sharing a name prefix", () => {
    expect(() => resolveToolPath("/", "/project-evil/x", "/project")).toThrow(
      ToolInputError,
    );
  });
});
