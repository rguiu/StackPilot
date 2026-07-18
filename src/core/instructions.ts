import { readFileSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export function findGitRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const CANDIDATES = [".stackpilot/CLAUDE.md", "CLAUDE.md"] as const;

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

interface FoundInstructions {
  content: string;
  file: string;
}

function collectAt(dir: string): FoundInstructions | null {
  for (const rel of CANDIDATES) {
    const abs = join(dir, rel);
    const content = readOptional(abs);
    if (content) return { content, file: abs };
  }
  return null;
}

export function loadInstructions(cwd: string, home: string): string {
  const gitRoot = findGitRoot(cwd);
  const stopAt = gitRoot ?? home;
  let dir = resolve(cwd);

  const project: FoundInstructions[] = [];
  for (;;) {
    const entry = collectAt(dir);
    if (entry) project.push(entry);
    if (dir === stopAt) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const sections: string[] = [];
  const root = gitRoot ?? cwd;

  for (let i = project.length - 1; i >= 0; i--) {
    const entry = project[i];
    if (!entry) continue;
    const label = `# Project instructions (${relative(root, entry.file)}):`;
    sections.push(label, entry.content, "");
  }

  const user = readOptional(join(home, ".stackpilot", "CLAUDE.md"));
  if (user) {
    sections.push(
      "# User-level instructions (~/.stackpilot/CLAUDE.md):",
      user,
      "",
    );
  }

  return sections.join("\n").trim();
}
