// Patch tool: apply unified diffs. Alternative to Edit for multi-hunk
// changes — fewer tokens than quoting unchanged surrounding lines.

import { readFileSync, writeFileSync } from "node:fs";
import { absPath } from "../util/path.js";
import { requireString, type ToolDef, type ToolResult } from "./types.js";

interface Hunk {
  srcStart: number;
  srcLen: number;
  dstStart: number;
  dstLen: number;
  lines: string[];
}

function parseHunkHeader(header: string): Hunk | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(header);
  if (!m || !m[1] || !m[3]) return null;
  return {
    srcStart: parseInt(m[1], 10),
    srcLen: m[2] !== undefined ? parseInt(m[2], 10) : 1,
    dstStart: parseInt(m[3], 10),
    dstLen: m[4] !== undefined ? parseInt(m[4], 10) : 1,
    lines: [],
  };
}

function applyPatch(src: string[], patch: string): string {
  const patchLines = patch.split("\n");
  const hunks: Hunk[] = [];
  let currentHunk: Hunk | null = null;

  for (const line of patchLines) {
    // Skip diff headers (---, +++, index, diff --git, etc.)
    if (
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("new file ") ||
      line.startsWith("deleted file ")
    )
      continue;

    if (line.startsWith("@@")) {
      currentHunk = parseHunkHeader(line);
      if (currentHunk) hunks.push(currentHunk);
      continue;
    }

    if (
      currentHunk &&
      (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"))
    ) {
      currentHunk.lines.push(line);
    }
    // Bare empty lines ("") and "\ No newline" lines are NOT hunk body:
    // unified-diff context lines always carry a leading space, so a truly
    // empty line is either a trailing-newline artifact of split("\n") or a
    // separator. Collecting it would mis-consume a source line and corrupt
    // the file. If a real blank context line was emitted without its leading
    // space, the srcLen cross-check below fails loudly instead.
  }

  if (hunks.length === 0) throw new PatchError("no hunks in patch");

  // Apply hunks in reverse order (from end of file) to keep line numbers stable.
  const out = [...src];
  for (let h = hunks.length - 1; h >= 0; h--) {
    const hunk = hunks[h];
    if (!hunk) continue;
    const srcIdx = hunk.srcStart - 1; // 0-indexed

    if (srcIdx < 0 || srcIdx > out.length) {
      throw new PatchError(
        `hunk starts at line ${hunk.srcStart}, out of range (file has ${out.length} lines)`,
      );
    }

    // Verify context matches before applying. Every context (" ") and
    // deletion ("-") line MUST match the source at srcPos — including past
    // EOF, where "no such line" is itself a mismatch (previously skipped,
    // which silently accepted bogus hunks).
    const resultLines: string[] = [];
    let srcPos = srcIdx;

    for (const line of hunk.lines) {
      if (line.startsWith("+")) {
        resultLines.push(line.slice(1));
        continue;
      }
      // Context (" ") or deletion ("-"): both consume a source line.
      const plain = line.slice(1);
      if (srcPos >= out.length) {
        throw new PatchError(
          `hunk failed at line ${srcPos + 1}: expected "${plain}", but file ended`,
        );
      }
      if (out[srcPos] !== plain) {
        const kind = line.startsWith("-") ? "-" : " ";
        throw new PatchError(
          `hunk failed at line ${srcPos + 1}: expected "${out[srcPos]}", got "${kind}${plain}"`,
        );
      }
      if (line.startsWith(" ")) resultLines.push(plain);
      srcPos++;
    }

    // Cross-check the parsed body against the header count: srcPos must have
    // advanced by exactly srcLen. A mismatch means a malformed/hand-edited
    // diff — splice by the header would remove the wrong number of lines and
    // corrupt the file, so refuse instead.
    const consumed = srcPos - srcIdx;
    if (consumed !== hunk.srcLen) {
      throw new PatchError(
        `hunk header claims ${hunk.srcLen} source line(s) but body consumes ${consumed}`,
      );
    }

    out.splice(srcIdx, hunk.srcLen, ...resultLines);
  }

  return out.join("\n");
}

class PatchError extends Error {
  constructor(message: string) {
    super(`patch error: ${message}`);
  }
}

export const patchTool: ToolDef = {
  name: "Patch",
  description:
    "Apply a unified diff to a file. Use for small, targeted changes — " +
    "fewer tokens than Edit since unchanged context doesn't need quoting. " +
    "The patch must apply cleanly to the current file contents.",
  runPermitless: false,
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "File to patch" },
      patch: {
        type: "string",
        description:
          "Unified diff. Must include proper hunk headers (@@ -line,count +line,count @@). " +
          "Context lines must match exactly.",
      },
    },
    required: ["file_path", "patch"],
  },
  execute(input, cwd): Promise<ToolResult> {
    const path = absPath(cwd, requireString(input, "file_path"));
    const patch = requireString(input, "patch");

    let original: string;
    try {
      original = readFileSync(path, "utf8");
    } catch (err) {
      return Promise.resolve({
        output: (err as Error).message,
        isError: true,
      });
    }

    const srcLines = original.split("\n");
    let result: string;
    try {
      result = applyPatch(srcLines, patch);
    } catch (err) {
      if (err instanceof PatchError) {
        return Promise.resolve({ output: err.message, isError: true });
      }
      throw err;
    }

    writeFileSync(path, result, "utf8");
    return Promise.resolve({ output: `patched ${path}` });
  },
};
