import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { parseMode, type SessionMode } from "../core/mode.js";

export interface CliArgs {
  prompt?: string;
  continue_: boolean;
  yolo: boolean;
  model?: string;
  tools?: string[];
  json: boolean;
  version: boolean;
  mode?: SessionMode;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    continue_: false,
    yolo: false,
    json: false,
    version: false,
  };
  const rest = [...argv];
  while (rest.length > 0) {
    const a = rest.shift() as string;
    if (a === "-p" || a === "--print") {
      const val = rest[0];
      if (val !== undefined && !val.startsWith("-")) {
        rest.shift();
        args.prompt = val;
      }
    } else if (a === "-c" || a === "--continue") {
      args.continue_ = true;
    } else if (a === "--yolo") {
      args.yolo = true;
    } else if (a === "--model") {
      args.model = rest.shift();
    } else if (a === "--tools") {
      args.tools = (rest.shift() ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (a === "--mode") {
      const raw = rest.shift() ?? "";
      const parsed = parseMode(raw);
      if (!parsed) {
        console.error(`unknown mode: ${raw} (valid: build, plan)`);
        process.exit(2);
      }
      args.mode = parsed;
    } else if (a === "--json") {
      args.json = true;
    } else if (a === "-v" || a === "--version") {
      args.version = true;
    } else if (!a.startsWith("-")) {
      args.prompt = [a, ...rest].join(" ");
      rest.length = 0;
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

export function versionString(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..", "..");
  let version = "0.0.0";
  try {
    const pkg = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    ) as { version?: string };
    if (pkg.version) version = pkg.version;
  } catch {
    // fall through with default
  }
  let commit = "";
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // not a git checkout
  }
  return commit ? `stackpilot ${version} (${commit})` : `stackpilot ${version}`;
}
