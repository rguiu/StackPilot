import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { patchTool } from "./patch.js";

let tmp: string;

function setup(name: string, content: string): { dir: string; file: string } {
  tmp = resolve(mkdtempSync(join(tmpdir(), "sp-patch-test-")));
  writeFileSync(join(tmp, name), content, "utf8");
  return { dir: tmp, file: name };
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("patchTool — clean application", () => {
  it("applies a single-hunk replacement", async () => {
    const { dir, file } = setup("a.txt", "one\ntwo\nthree\n");
    const patch = ["@@ -1,3 +1,3 @@", " one", "-two", "+TWO", " three"].join(
      "\n",
    );
    const result = await patchTool.execute({ file_path: file, patch }, dir);
    expect(result.isError).toBeFalsy();
    expect(readFileSync(join(dir, file), "utf8")).toBe("one\nTWO\nthree\n");
  });

  it("applies multiple hunks (reverse order keeps line numbers stable)", async () => {
    const { dir, file } = setup("a.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
    const patch = [
      "@@ -1,2 +1,2 @@",
      "-1",
      "+ONE",
      " 2",
      "@@ -9,2 +9,2 @@",
      " 9",
      "-10",
      "+TEN",
    ].join("\n");
    const result = await patchTool.execute({ file_path: file, patch }, dir);
    expect(result.isError).toBeFalsy();
    expect(readFileSync(join(dir, file), "utf8")).toBe(
      "ONE\n2\n3\n4\n5\n6\n7\n8\n9\nTEN\n",
    );
  });

  it("ignores diff headers (---, +++, diff --git, index)", async () => {
    const { dir, file } = setup("a.txt", "x\ny\n");
    const patch = [
      "diff --git a/a.txt b/a.txt",
      "index 111..222 100644",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,2 +1,2 @@",
      " x",
      "-y",
      "+Y",
    ].join("\n");
    const result = await patchTool.execute({ file_path: file, patch }, dir);
    expect(result.isError).toBeFalsy();
    expect(readFileSync(join(dir, file), "utf8")).toBe("x\nY\n");
  });

  it("handles a pure insertion (srcLen counts context only)", async () => {
    const { dir, file } = setup("a.txt", "a\nb\n");
    const patch = ["@@ -1,2 +1,3 @@", " a", "+inserted", " b"].join("\n");
    const result = await patchTool.execute({ file_path: file, patch }, dir);
    expect(result.isError).toBeFalsy();
    expect(readFileSync(join(dir, file), "utf8")).toBe("a\ninserted\nb\n");
  });
});

describe("patchTool — corruption guards (must fail, not corrupt)", () => {
  it("rejects a hunk whose context does not match", async () => {
    const { dir, file } = setup("a.txt", "one\ntwo\nthree\n");
    const original = readFileSync(join(dir, file), "utf8");
    const patch = ["@@ -1,3 +1,3 @@", " one", "-WRONG", "+TWO", " three"].join(
      "\n",
    );
    const result = await patchTool.execute({ file_path: file, patch }, dir);
    expect(result.isError).toBe(true);
    // File must be untouched.
    expect(readFileSync(join(dir, file), "utf8")).toBe(original);
  });

  it("rejects context/deletions claimed past EOF (previously silently accepted)", async () => {
    const { dir, file } = setup("a.txt", "one\ntwo\n");
    const original = readFileSync(join(dir, file), "utf8");
    // Header claims 4 source lines starting at 1, but file only has 2.
    const patch = [
      "@@ -1,4 +1,4 @@",
      " one",
      " two",
      "-three",
      "+THREE",
      " four",
    ].join("\n");
    const result = await patchTool.execute({ file_path: file, patch }, dir);
    expect(result.isError).toBe(true);
    expect(readFileSync(join(dir, file), "utf8")).toBe(original);
  });

  it("rejects a header srcLen that disagrees with the body (previously mis-spliced)", async () => {
    const { dir, file } = setup("a.txt", "a\nb\nc\nd\n");
    const original = readFileSync(join(dir, file), "utf8");
    // Header says 3 source lines but body only consumes 2 (context+del).
    const patch = ["@@ -1,3 +1,2 @@", " a", "-b", "+B"].join("\n");
    const result = await patchTool.execute({ file_path: file, patch }, dir);
    expect(result.isError).toBe(true);
    expect(readFileSync(join(dir, file), "utf8")).toBe(original);
  });

  it("rejects a hunk starting out of range", async () => {
    const { dir, file } = setup("a.txt", "a\nb\n");
    const original = readFileSync(join(dir, file), "utf8");
    const patch = ["@@ -50,1 +50,1 @@", "-x", "+y"].join("\n");
    const result = await patchTool.execute({ file_path: file, patch }, dir);
    expect(result.isError).toBe(true);
    expect(readFileSync(join(dir, file), "utf8")).toBe(original);
  });

  it("errors when there are no hunks", async () => {
    const { dir, file } = setup("a.txt", "a\n");
    const result = await patchTool.execute(
      { file_path: file, patch: "just some text\nno hunks here" },
      dir,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("no hunks");
  });

  it("returns an error (not a throw) when the file does not exist", async () => {
    const { dir } = setup("a.txt", "a\n");
    const patch = ["@@ -1,1 +1,1 @@", "-a", "+b"].join("\n");
    const result = await patchTool.execute(
      { file_path: "nope.txt", patch },
      dir,
    );
    expect(result.isError).toBe(true);
  });
});
