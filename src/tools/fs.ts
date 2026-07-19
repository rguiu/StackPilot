// File tools: Read, Write, Edit. Claude-familiar semantics:
// Read returns numbered lines; Edit requires a unique exact match.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { absPath } from "../util/path.js";
import {
  requireString,
  truncate,
  type ToolDef,
  type ToolResult,
} from "./types.js";

const MAX_LINES = 2000;
const MAX_LINE_LEN = 2000;
const MAX_OUTPUT = 40_000;

export const readTool: ToolDef = {
  name: "Read",
  description:
    "Read a file. Returns line-numbered content. Use offset/limit for large files.",
  runPermitless: true,
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to the file" },
      offset: { type: "number", description: "1-indexed first line" },
      limit: { type: "number", description: "Max lines to return" },
    },
    required: ["file_path"],
  },
  execute(input, cwd): Promise<ToolResult> {
    const path = absPath(cwd, requireString(input, "file_path"));
    const offset = typeof input.offset === "number" ? input.offset : 1;
    const limit = typeof input.limit === "number" ? input.limit : MAX_LINES;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EISDIR") {
        return Promise.resolve({
          output: `"${path}" is a directory, not a file — use Glob to list its contents`,
          isError: true,
        });
      }
      return Promise.resolve({
        output: (err as Error).message,
        isError: true,
      });
    }
    const lines = raw.split("\n");
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice
      .map((l, i) => `${offset + i}: ${l.slice(0, MAX_LINE_LEN)}`)
      .join("\n");
    const suffix =
      offset - 1 + limit < lines.length
        ? `\n… (${lines.length} lines total, showing ${offset}-${offset - 1 + slice.length})`
        : "";
    return Promise.resolve({
      output: truncate(numbered + suffix, MAX_OUTPUT),
    });
  },
};

export const writeTool: ToolDef = {
  name: "Write",
  description: "Write content to a file, creating parent directories.",
  runPermitless: false,
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      content: { type: "string" },
    },
    required: ["file_path", "content"],
  },
  execute(input, cwd): Promise<ToolResult> {
    const path = absPath(cwd, requireString(input, "file_path"));
    const content = input.content;
    if (typeof content !== "string") {
      return Promise.resolve({
        output: '"content" must be a string',
        isError: true,
      });
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
    return Promise.resolve({
      output: `wrote ${Buffer.byteLength(content)} bytes to ${path}`,
    });
  },
};

export const editTool: ToolDef = {
  name: "Edit",
  description:
    "Exact-string replacement in a file. old_string must match exactly once unless replace_all.",
  runPermitless: false,
  inputSchema: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      old_string: { type: "string" },
      new_string: { type: "string" },
      replace_all: { type: "boolean" },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  execute(input, cwd): Promise<ToolResult> {
    const path = absPath(cwd, requireString(input, "file_path"));
    const oldString = requireString(input, "old_string");
    const newString =
      typeof input.new_string === "string" ? input.new_string : "";
    if (oldString === newString) {
      return Promise.resolve({
        output: "old_string and new_string are identical",
        isError: true,
      });
    }
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (err) {
      return Promise.resolve({
        output: (err as Error).message,
        isError: true,
      });
    }
    const count = raw.split(oldString).length - 1;
    if (count === 0) {
      return Promise.resolve({
        output: "old_string not found in file",
        isError: true,
      });
    }
    if (count > 1 && input.replace_all !== true) {
      return Promise.resolve({
        output: `old_string matches ${count} times; provide more context or set replace_all`,
        isError: true,
      });
    }
    const next =
      input.replace_all === true
        ? raw.split(oldString).join(newString)
        : raw.replace(oldString, newString);
    writeFileSync(path, next, "utf8");
    return Promise.resolve({
      output: `replaced ${input.replace_all === true ? count : 1} occurrence(s) in ${path}`,
    });
  },
};
