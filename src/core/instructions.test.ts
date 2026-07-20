import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findGitRoot, loadInstructions } from "./instructions.js";

let tmp: string;

function setup(): string {
  tmp = resolve(mkdtempSync(join(tmpdir(), "sp-instr-")));
  return tmp;
}

function write(dir: string, rel: string, content: string): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("findGitRoot", () => {
  it("finds the nearest ancestor containing .git", () => {
    const root = setup();
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "a", "b"), { recursive: true });
    expect(findGitRoot(join(root, "a", "b"))).toBe(root);
  });

  it("returns null when there is no .git up to the fs root", () => {
    const root = setup(); // a bare tmp dir, no .git
    expect(findGitRoot(root)).toBeNull();
  });
});

describe("loadInstructions", () => {
  it("returns empty string when nothing is found", () => {
    const root = setup();
    mkdirSync(join(root, ".git"));
    expect(loadInstructions(root, join(root, "home"))).toBe("");
  });

  it("prefers .stackpilot/CLAUDE.md over a bare CLAUDE.md at the same level", () => {
    const root = setup();
    mkdirSync(join(root, ".git"));
    write(root, ".stackpilot/CLAUDE.md", "namespaced wins");
    write(root, "CLAUDE.md", "bare loses");
    const out = loadInstructions(root, join(root, "home"));
    expect(out).toContain("namespaced wins");
    expect(out).not.toContain("bare loses");
  });

  it("walks cwd → git root, ordering root-first (nearest last)", () => {
    const root = setup();
    mkdirSync(join(root, ".git"));
    write(root, "CLAUDE.md", "ROOT rules");
    mkdirSync(join(root, "sub"), { recursive: true });
    write(root, "sub/CLAUDE.md", "SUB rules");
    const out = loadInstructions(join(root, "sub"), join(root, "home"));
    expect(out).toContain("ROOT rules");
    expect(out).toContain("SUB rules");
    // Root section appears before the nearer sub section.
    expect(out.indexOf("ROOT rules")).toBeLessThan(out.indexOf("SUB rules"));
  });

  it("appends user-level ~/.stackpilot/CLAUDE.md", () => {
    const root = setup();
    mkdirSync(join(root, ".git"));
    const home = join(root, "home");
    write(home, ".stackpilot/CLAUDE.md", "USER prefs");
    const out = loadInstructions(root, home);
    expect(out).toContain("USER prefs");
    expect(out).toContain("User-level instructions");
  });

  it("does not walk above the git root", () => {
    const root = setup();
    mkdirSync(join(root, "repo", ".git"), { recursive: true });
    write(root, "CLAUDE.md", "ABOVE the repo");
    write(root, "repo/CLAUDE.md", "inside repo");
    const out = loadInstructions(join(root, "repo"), join(root, "home"));
    expect(out).toContain("inside repo");
    expect(out).not.toContain("ABOVE the repo");
  });
});
