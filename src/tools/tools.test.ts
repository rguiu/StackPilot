import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { editTool, readTool } from "./fs.js";
import { globToRegExp } from "./search.js";
import { createRegistry, unknownToolNames } from "./index.js";

const dir = mkdtempSync(join(tmpdir(), "sp-tools-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("Read", () => {
  it("numbers lines from offset", async () => {
    const f = join(dir, "r.txt");
    writeFileSync(f, "a\nb\nc\nd\n");
    const res = await readTool.execute(
      { file_path: f, offset: 2, limit: 2 },
      dir,
    );
    expect(res.isError).toBeUndefined();
    expect(res.output).toContain("2: b");
    expect(res.output).toContain("3: c");
    expect(res.output).not.toContain("1: a");
  });

  it("errors on a missing file", async () => {
    const res = await readTool.execute({ file_path: join(dir, "nope") }, dir);
    expect(res.isError).toBe(true);
  });
});

describe("Edit", () => {
  it("replaces a unique match", async () => {
    const f = join(dir, "e.txt");
    writeFileSync(f, "one two three");
    const res = await editTool.execute(
      { file_path: f, old_string: "two", new_string: "2" },
      dir,
    );
    expect(res.isError).toBeUndefined();
    expect(readFileSync(f, "utf8")).toBe("one 2 three");
  });

  it("rejects a missing old_string", async () => {
    const f = join(dir, "e2.txt");
    writeFileSync(f, "abc");
    const res = await editTool.execute(
      { file_path: f, old_string: "zzz", new_string: "y" },
      dir,
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("not found");
  });

  it("rejects ambiguous matches without replace_all", async () => {
    const f = join(dir, "e3.txt");
    writeFileSync(f, "x x x");
    const res = await editTool.execute(
      { file_path: f, old_string: "x", new_string: "y" },
      dir,
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("3 times");
  });

  it("replaces all when asked", async () => {
    const f = join(dir, "e4.txt");
    writeFileSync(f, "x x x");
    const res = await editTool.execute(
      { file_path: f, old_string: "x", new_string: "y", replace_all: true },
      dir,
    );
    expect(res.isError).toBeUndefined();
    expect(readFileSync(f, "utf8")).toBe("y y y");
  });
});

describe("globToRegExp", () => {
  it.each([
    ["*.ts", "a.ts", true],
    ["*.ts", "a/b.ts", false],
    ["**/*.ts", "a/b/c.ts", true],
    ["**/*.ts", "top.ts", true],
    ["src/**/*.test.ts", "src/core/loop.test.ts", true],
    ["src/**/*.test.ts", "src/core/loop.ts", false],
    ["a?c", "abc", true],
    ["a?c", "a/c", false],
  ])("%s vs %s → %s", (pattern, path, expected) => {
    expect(globToRegExp(pattern).test(path)).toBe(expected);
  });
});

describe("registry enabled-set filtering", () => {
  it("defaults to all tools enabled", () => {
    const r = createRegistry();
    expect(r.schemas()).toHaveLength(r.defs.length);
    expect(r.isEnabled("Bash")).toBe(true);
  });

  it("filters schemas preserving canonical order", () => {
    const r = createRegistry();
    r.setEnabled(["Glob", "Read"]); // reversed on purpose
    expect(r.schemas().map((s) => s.name)).toEqual(["Read", "Glob"]);
    expect(r.enabledNames()).toEqual(["Read", "Glob"]);
    expect(r.isEnabled("Bash")).toBe(false);
    expect(r.get("Bash")).toBeDefined(); // catalog unaffected
  });

  it("supports the empty set and reset to all", () => {
    const r = createRegistry();
    r.setEnabled([]);
    expect(r.schemas()).toHaveLength(0);
    r.setEnabled(null);
    expect(r.schemas()).toHaveLength(r.defs.length);
  });

  it("reports unknown tool names", () => {
    const r = createRegistry();
    expect(unknownToolNames(r, ["Read", "Nope", "Bash", "Zap"])).toEqual([
      "Nope",
      "Zap",
    ]);
  });
});
