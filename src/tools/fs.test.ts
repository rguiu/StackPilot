import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readTool, writeTool, editTool } from "./fs.js";
import { executeTool } from "./index.js";

let tmp: string;

function setup(...files: Record<string, string>[]): string {
  tmp = resolve(mkdtempSync(join(tmpdir(), "sp-fs-test-")));
  for (const file of files) {
    for (const [name, content] of Object.entries(file)) {
      writeFileSync(join(tmp, name), content, "utf8");
    }
  }
  return tmp;
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("workspace confinement", () => {
  it("Read refuses an out-of-workspace path when confinement is on", async () => {
    const dir = setup();
    const res = await executeTool(
      readTool,
      { file_path: "/etc/hosts" },
      dir,
      dir,
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("outside the workspace");
  });

  it("Write refuses a ../ escape when confinement is on", async () => {
    const dir = setup();
    const res = await executeTool(
      writeTool,
      { file_path: "../escape.txt", content: "x" },
      dir,
      dir,
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("outside the workspace");
  });

  it("allows in-workspace paths when confinement is on", async () => {
    const dir = setup();
    const res = await executeTool(
      writeTool,
      { file_path: "inside.txt", content: "ok" },
      dir,
      dir,
    );
    expect(res.isError).toBeFalsy();
  });
});

describe("writeTool", () => {
  it("writes content to a file", async () => {
    const dir = setup();
    const result = await writeTool.execute(
      { file_path: "hello.txt", content: "hello world" },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("wrote");
    expect(result.output).toContain("hello.txt");
    expect(readFileSync(join(dir, "hello.txt"), "utf8")).toBe("hello world");
  });

  it("creates parent directories automatically", async () => {
    const dir = setup();
    const result = await writeTool.execute(
      { file_path: "deep/nested/file.txt", content: "nested" },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(readFileSync(join(dir, "deep/nested/file.txt"), "utf8")).toBe(
      "nested",
    );
  });

  it("overwrites an existing file", async () => {
    const dir = setup({ "exists.txt": "old" });
    await writeTool.execute({ file_path: "exists.txt", content: "new" }, dir);
    expect(readFileSync(join(dir, "exists.txt"), "utf8")).toBe("new");
  });

  it("returns error when content is not a string", async () => {
    const dir = setup();
    const result = await writeTool.execute(
      { file_path: "test.txt", content: 42 },
      dir,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('"content" must be a string');
  });

  it("uses absolute paths", async () => {
    const dir = setup();
    const abs = join(dir, "abs.txt");
    const result = await writeTool.execute(
      { file_path: abs, content: "absolute" },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(readFileSync(abs, "utf8")).toBe("absolute");
  });
});

describe("editTool", () => {
  it("replaces a unique match", async () => {
    const dir = setup({ "f.txt": "line1\nline2\nline3" });
    const result = await editTool.execute(
      { file_path: "f.txt", old_string: "line2", new_string: "LINE2" },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("replaced 1 occurrence");
    expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe(
      "line1\nLINE2\nline3",
    );
  });

  it("replaces all matches with replace_all", async () => {
    const dir = setup({ "f.txt": "a a a" });
    const result = await editTool.execute(
      {
        file_path: "f.txt",
        old_string: "a",
        new_string: "x",
        replace_all: true,
      },
      dir,
    );
    expect(result.isError).toBeFalsy();
    expect(result.output).toContain("replaced 3 occurrence(s)");
    expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("x x x");
  });

  it("rejects when old_string matches multiple times and replace_all is false", async () => {
    const dir = setup({ "f.txt": "cat cat cat" });
    const result = await editTool.execute(
      { file_path: "f.txt", old_string: "cat", new_string: "dog" },
      dir,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("matches 3 times");
    expect(result.output).toContain("replace_all");
  });

  it("rejects when old_string is not found", async () => {
    const dir = setup({ "f.txt": "hello" });
    const result = await editTool.execute(
      { file_path: "f.txt", old_string: "goodbye", new_string: "x" },
      dir,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toBe("old_string not found in file");
  });

  it("rejects when old_string and new_string are identical", async () => {
    const dir = setup({ "f.txt": "same" });
    const result = await editTool.execute(
      { file_path: "f.txt", old_string: "same", new_string: "same" },
      dir,
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain("identical");
  });

  it("returns error for non-existent file", async () => {
    const dir = setup();
    const result = await editTool.execute(
      { file_path: "gone.txt", old_string: "x", new_string: "y" },
      dir,
    );
    expect(result.isError).toBe(true);
  });
});
