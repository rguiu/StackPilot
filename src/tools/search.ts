// Search tools: Grep (ripgrep-backed) and Glob (own walk, no deps).

import { execFile } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  optionalString,
  requireString,
  truncate,
  type ToolDef,
  type ToolResult,
} from "./types.js";

const MAX_OUTPUT = 30_000;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".stackpilot"]);

export const grepTool: ToolDef = {
  name: "Grep",
  description:
    "Search file contents with a regex (ripgrep). Optional path and glob filter.",
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      glob: { type: "string", description: 'e.g. "*.ts"' },
    },
    required: ["pattern"],
  },
  async execute(input, cwd): Promise<ToolResult> {
    const pattern = requireString(input, "pattern");
    const path = optionalString(input, "path") ?? ".";
    const glob = optionalString(input, "glob");
    const args = [
      "--line-number",
      "--no-heading",
      "--color",
      "never",
      "--max-count",
      "50",
    ];
    if (glob) args.push("--glob", glob);
    args.push("--regexp", pattern, path);
    return new Promise<ToolResult>((resolvePromise) => {
      execFile(
        "rg",
        args,
        { cwd, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
            resolvePromise({
              output: "ripgrep (rg) is not installed",
              isError: true,
            });
          } else if (err && stdout.length === 0 && stderr.length === 0) {
            resolvePromise({ output: "no matches" });
          } else if (stderr && stdout.length === 0) {
            resolvePromise({ output: stderr.trim(), isError: true });
          } else {
            resolvePromise({ output: truncate(stdout.trim(), MAX_OUTPUT) });
          }
        },
      );
    });
  },
};

// Convert a glob pattern to a RegExp. Supports **, *, ? — enough for agent
// usage; extend only when a recorded failure demands it (YAGNI).
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += pattern[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += pattern[i + 2] === "/" ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += /[a-zA-Z0-9_/-]/.test(ch) ? ch : `\\${ch}`;
    }
  }
  return new RegExp(`^${re}$`);
}

function walk(dir: string, out: string[], depth: number): void {
  if (depth > 12 || out.length > 5000) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(full, out, depth + 1);
    else out.push(full);
  }
}

export const globTool: ToolDef = {
  name: "Glob",
  description: 'Find files by glob pattern, e.g. "src/**/*.ts".',
  readOnly: true,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string", description: "Base directory (default cwd)" },
    },
    required: ["pattern"],
  },
  async execute(input, cwd): Promise<ToolResult> {
    const pattern = requireString(input, "pattern");
    const baseInput = optionalString(input, "path") ?? ".";
    const base = isAbsolute(baseInput) ? baseInput : resolve(cwd, baseInput);
    const files: string[] = [];
    walk(base, files, 0);
    const re = globToRegExp(pattern);
    const matches = files
      .map((f) => relative(base, f))
      .filter((f) => re.test(f))
      .sort()
      .slice(0, 200);
    return {
      output: matches.length > 0 ? matches.join("\n") : "no files match",
    };
  },
};
