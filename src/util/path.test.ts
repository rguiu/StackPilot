import { afterEach, describe, expect, it } from "vitest";
import {
  absPath,
  getWorkspaceRoot,
  resolveToolPath,
  setWorkspaceRoot,
} from "./path.js";
import { ToolInputError } from "../tools/types.js";

afterEach(() => {
  setWorkspaceRoot(null); // never leak the boundary between tests
});

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
    expect(getWorkspaceRoot()).toBeNull();
    expect(resolveToolPath("/proj", "/etc/passwd")).toBe("/etc/passwd");
  });
});

describe("workspace confinement (enabled)", () => {
  it("allows paths inside the root", () => {
    setWorkspaceRoot("/proj");
    expect(resolveToolPath("/proj", "src/a.ts")).toBe("/proj/src/a.ts");
    expect(resolveToolPath("/proj", "/proj/deep/b.ts")).toBe("/proj/deep/b.ts");
  });

  it("allows the root itself", () => {
    setWorkspaceRoot("/proj");
    expect(resolveToolPath("/proj", ".")).toBe("/proj");
  });

  it("rejects an absolute path outside the root", () => {
    setWorkspaceRoot("/proj");
    expect(() => resolveToolPath("/proj", "/etc/passwd")).toThrow(
      ToolInputError,
    );
  });

  it("rejects a ../ traversal that escapes the root", () => {
    setWorkspaceRoot("/proj");
    expect(() => resolveToolPath("/proj", "../secrets/key")).toThrow(
      ToolInputError,
    );
  });

  it("rejects a sibling directory sharing a name prefix", () => {
    // /project-evil must NOT count as inside /project
    setWorkspaceRoot("/project");
    expect(() => resolveToolPath("/", "/project-evil/x")).toThrow(
      ToolInputError,
    );
  });

  it("normalizes the root", () => {
    setWorkspaceRoot("/proj/./sub/..");
    expect(getWorkspaceRoot()).toBe("/proj");
  });
});
