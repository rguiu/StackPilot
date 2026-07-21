#!/usr/bin/env node
// stackpilot CLI: REPL by default, -p <prompt> for one headless turn.
//
//   stackpilot                 interactive REPL, new session
//   stackpilot -c              continue newest session for this cwd
//   stackpilot -p "…"          one turn, print result, exit
//   stackpilot --yolo          skip permission prompts
//   stackpilot --model <id>    override model

import { createInterface, type Interface } from "node:readline/promises";
import { realpathSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import process from "node:process";
import { isCancel, select } from "@clack/prompts";
import { loadAppConfig, ConfigError } from "../config.js";
import { buildSystemPrompt, getGitContext } from "../core/prompt.js";
import { loadInstructions, findGitRoot } from "../core/instructions.js";
import { runTurn, type TurnIO, type TurnStats } from "../core/loop.js";
import { CacheLedger } from "../core/cache.js";
import { reduce } from "../core/reducer.js";
import { SessionStore } from "../session/store.js";
import { createRegistry, unknownToolNames } from "../tools/index.js";
import { discoverSkills, formatAvailableSkills } from "../tools/skill.js";
import { streamWithRetry } from "../transport/anthropic.js";
import { runApp } from "../tui/app.js";
import { formatAge, permissionPromptPlain } from "../tui/render.js";
import { runHook, logHookResult } from "../core/hooks.js";
import { openMemoryDb, storeSessionMeta } from "../tools/memory.js";
import type { SessionState } from "../core/policies.js";
import { setWorkspaceRoot } from "../util/path.js";

interface CliArgs {
  prompt?: string;
  continue_: boolean;
  yolo: boolean;
  model?: string;
  tools?: string[];
  json: boolean;
  version: boolean;
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
      const val = rest.shift();
      if (val !== undefined) args.prompt = val;
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
    } else if (a === "--json") {
      args.json = true;
    } else if (a === "-v" || a === "--version") {
      args.version = true;
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

// Version string: package version + best-effort git commit of the checkout the
// running dist/ was built from. The build root is two levels up from
// dist/cli/main.js. Surfaces stale-binary situations (the SHA won't match HEAD
// of a checkout you rebuilt but didn't relink).
export function versionString(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // dist/cli
  const root = join(here, "..", ".."); // package root
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
    // not a git checkout (published install) — version alone
  }
  return commit ? `stackpilot ${version} (${commit})` : `stackpilot ${version}`;
}

function openStore(cwd: string, continue_: boolean): SessionStore {
  if (continue_) {
    const newest = SessionStore.newestFor(cwd);
    if (newest) {
      const store = SessionStore.open(newest);
      const n = reduce(store.all()).messages.length;
      console.error(`resumed ${store.sessionId} (${n} messages)`);
      return store;
    }
    console.error("no previous session here — starting fresh");
  }
  return SessionStore.create(cwd);
}

// Interactive -c with several sessions: arrow-key picker. Cancel exits.
async function pickSession(cwd: string): Promise<SessionStore> {
  const summaries = SessionStore.summariesFor(cwd);
  if (summaries.length === 0) {
    console.error("no previous session here — starting fresh");
    return SessionStore.create(cwd);
  }
  if (summaries.length === 1 && summaries[0])
    return SessionStore.open(summaries[0].path);

  const now = Date.now();
  const choice = await select({
    message: "Resume which session?",
    options: summaries.slice(0, 10).map((s) => ({
      value: s.path,
      label: `${s.id.slice(0, 8)} · ${formatAge(now - s.mtimeMs)} · ${(s.preview ?? "(no prompt)").slice(0, 50)}`,
    })),
  });
  if (isCancel(choice)) {
    console.error("cancelled");
    process.exit(0);
  }
  const store = SessionStore.open(choice);
  const n = reduce(store.all()).messages.length;
  console.error(`resumed ${store.sessionId} (${n} messages)`);
  return store;
}

function makeIO(rl: Interface | null, yolo: boolean, json = false): TurnIO {
  if (json) {
    return {
      onText: (d) =>
        process.stdout.write(
          JSON.stringify({ type: "text", content: d }) + "\n",
        ),
      onToolStart: (name, input) =>
        process.stdout.write(
          JSON.stringify({ type: "tool_start", name, input }) + "\n",
        ),
      onToolEnd: (_name, output, isError) =>
        process.stdout.write(
          JSON.stringify({
            type: "tool_end",
            output: output.slice(0, 500),
            isError,
          }) + "\n",
        ),
      permit: () => {
        if (yolo) return Promise.resolve({ allowed: true });
        return Promise.resolve({ allowed: false });
      },
    };
  }

  return {
    onText: (d) => process.stdout.write(d),
    onToolStart: (name, input) => {
      const brief = JSON.stringify(input);
      process.stderr.write(
        `\n⏺ ${name} ${brief.length > 120 ? brief.slice(0, 120) + "…" : brief}\n`,
      );
    },
    onToolEnd: (_name, output, isError) => {
      const first = output.split("\n")[0] ?? "";
      process.stderr.write(`  ${isError ? "✗" : "✓"} ${first.slice(0, 100)}\n`);
    },
    permit: async (name, input) => {
      if (yolo) return { allowed: true };
      if (!rl) return { allowed: false };
      const answer = await rl.question(permissionPromptPlain(name, input));
      const norm = answer.trim().toLowerCase();
      if (norm === "y" || norm === "yes") return { allowed: true };
      if (norm.startsWith("n ") || norm.startsWith("no ")) {
        return { allowed: false, reason: norm.slice(norm.indexOf(" ") + 1) };
      }
      return { allowed: false };
    },
  };
}

function printStats(stats: TurnStats, model: string, json = false): void {
  if (json) {
    process.stdout.write(
      JSON.stringify({
        type: "turn_end",
        model,
        requests: stats.requests,
        toolCalls: stats.toolCalls,
        usage: stats.usage,
        costUsd: stats.costUsd,
      }) + "\n",
    );
    return;
  }
  const u = stats.usage;
  process.stderr.write(
    `\n[${model}] req ${stats.requests} · tools ${stats.toolCalls} · in ${u.input_tokens} · cache-r ${u.cache_read_input_tokens} · cache-w ${u.cache_creation_input_tokens} · out ${u.output_tokens}\n`,
  );
  for (const note of stats.notes) {
    process.stderr.write(`  ⚠ ${note}\n`);
  }
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) {
    process.stdout.write(versionString() + "\n");
    return;
  }
  let appConfig;
  try {
    appConfig = loadAppConfig(process.env, { model: args.model });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`stackpilot: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
  const config = appConfig.transport;
  const pricing = appConfig.pricing;

  const cwd = process.cwd();
  // Opt-in workspace confinement: file tools refuse paths outside the git
  // root (else cwd) when enabled in config. No-op when off.
  if (appConfig.confineToWorkspace) {
    setWorkspaceRoot(findGitRoot(cwd) ?? cwd);
  }
  const interactiveTty = process.stdin.isTTY && process.stdout.isTTY;
  const store =
    args.continue_ && args.prompt === undefined && interactiveTty
      ? await pickSession(cwd)
      : openStore(cwd, args.continue_);
  const skills = discoverSkills(homedir(), findGitRoot(cwd));
  const memoryDb = openMemoryDb(homedir());
  const sessionState: SessionState = {
    pagedOutputs: new Map(),
    readCache: new Map(),
  };
  const stream = streamWithRetry(config);
  const registry = createRegistry(skills, memoryDb, sessionState, {
    config,
    stream,
    cwd,
    maxToolResultChars: appConfig.maxToolResultChars,
  });
  const skillsAvailable = formatAvailableSkills(skills);
  // Precedence: --tools flag > config [tools].enabled > all enabled.
  const enabledTools = args.tools ?? appConfig.enabledTools;
  if (enabledTools !== null) {
    const unknown = unknownToolNames(registry, enabledTools);
    if (unknown.length > 0) {
      console.error(
        `stackpilot: unknown tool(s): ${unknown.join(", ")} (valid: ${registry.defs.map((d) => d.name).join(", ")})`,
      );
      process.exit(2);
    }
    registry.setEnabled(enabledTools);
  }
  const system = buildSystemPrompt(
    cwd,
    config.model,
    loadInstructions(cwd, homedir()),
    skillsAvailable,
    getGitContext(cwd),
  );
  const ledger = new CacheLedger();
  const hooks = appConfig.hooks;

  const sessionStartResults = await runHook(
    "session_start",
    hooks.sessionStart,
    store.sessionId,
    cwd,
  );
  if (sessionStartResults) {
    for (const r of sessionStartResults) {
      logHookResult("session_start", r, console.error);
    }
  }

  // session_end fires on normal exit paths (awaited) and SIGINT/SIGTERM.
  let sessionEndFired = false;
  async function fireSessionEnd(): Promise<void> {
    if (sessionEndFired) return;
    sessionEndFired = true;
    const results = await runHook(
      "session_end",
      hooks.sessionEnd,
      store.sessionId,
      cwd,
    );
    if (results) {
      for (const r of results) logHookResult("session_end", r, console.error);
    }
    try {
      storeSessionMeta(memoryDb, store.path, cwd);
    } catch {
      // memory extraction is best-effort
    }
  }
  process.once("SIGINT", () => {
    fireSessionEnd()
      .then(() => process.exit(0))
      .catch(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    fireSessionEnd()
      .then(() => process.exit(0))
      .catch(() => process.exit(0));
  });

  if (args.prompt !== undefined) {
    const io = makeIO(null, args.yolo, args.json);
    const stats = await runTurn(
      {
        cwd,
        store,
        registry,
        config,
        system,
        io,
        ledger,
        pricing,
        stream,
        hooks,
        sessionState,
        maxToolResultChars: appConfig.maxToolResultChars,
        autoCompactAtTokens: appConfig.autoCompactAtTokens,
      },
      args.prompt,
    );
    printStats(stats, config.model, args.json);
    return;
  }

  if (process.stdin.isTTY && process.stdout.isTTY) {
    await runApp({
      cwd,
      store,
      registry,
      config,
      system,
      pricing,
      autoCompactAtTokens: appConfig.autoCompactAtTokens,
      hooks,
      sessionState,
      maxToolResultChars: appConfig.maxToolResultChars,
    });
    await fireSessionEnd();
    return;
  }

  // Piped stdin (no TTY): plain line-by-line loop, no raw mode, no colors.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const io = makeIO(rl, args.yolo, args.json);
  for (;;) {
    let line: string;
    try {
      line = (await rl.question("\n> ")).trim();
    } catch {
      break; // stdin closed
    }
    if (line === "") continue;
    if (line === "/exit" || line === "/quit") break;
    if (line.startsWith("!")) {
      const cmd = line.slice(1).trim();
      if (cmd) {
        const { execFileSync } = await import("node:child_process");
        try {
          const output = execFileSync("bash", ["-c", cmd], {
            cwd,
            encoding: "utf8",
            maxBuffer: 1 * 1024 * 1024,
            timeout: 30_000,
          });
          process.stdout.write(output.trimEnd() + "\n");
        } catch (err: unknown) {
          const e = err as {
            stdout?: string;
            stderr?: string;
            message?: string;
          };
          if (typeof e.stdout === "string" && e.stdout.trim())
            process.stdout.write(e.stdout.trim() + "\n");
          if (typeof e.stderr === "string" && e.stderr.trim())
            process.stderr.write(e.stderr.trim() + "\n");
          if (!e.stdout && !e.stderr)
            process.stderr.write((e.message ?? "command failed") + "\n");
        }
      }
      continue;
    }
    const stats = await runTurn(
      {
        cwd,
        store,
        registry,
        config,
        system,
        io,
        ledger,
        pricing,
        stream,
        hooks,
        sessionState,
        maxToolResultChars: appConfig.maxToolResultChars,
      },
      line,
    );
    printStats(stats, config.model, args.json);
  }
  rl.close();
  await fireSessionEnd();
}

// Entry detection must survive three launch shapes: `tsx src/cli/main.ts`
// (argv[1] = .ts file), `node dist/cli/main.js`, and the npm bin shim
// (argv[1] = a SYMLINK named `stackpilot`). Name-suffix comparison fails
// the symlink case — main() silently never ran and the process exited 0 —
// so resolve the real path and compare canonical file URLs.
const isDirect = ((): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
})();
if (isDirect) {
  main().catch((err: unknown) => {
    console.error(
      `stackpilot: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
}
