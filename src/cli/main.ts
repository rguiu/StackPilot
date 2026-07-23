#!/usr/bin/env node
// stackpilot CLI: REPL by default, -p <prompt> for one headless turn.
//
//   stackpilot                 interactive REPL, new session
//   stackpilot -c              continue newest session for this cwd
//   stackpilot -p "…"          one turn, print result, exit
//   stackpilot --yolo          skip permission prompts
//   stackpilot --model <id>    override model

import { homedir } from "node:os";
import process from "node:process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadAppConfig, ConfigError, type ModelPricing } from "../config.js";
import { buildSystemPrompt, getGitContext } from "../core/prompt.js";
import { loadInstructions, findGitRoot } from "../core/instructions.js";
import { CacheLedger } from "../core/cache.js";
import {
  createRegistry,
  unknownToolNames,
  CORE_TOOLS,
} from "../tools/index.js";
import { discoverSkills, formatAvailableSkills } from "../tools/skill.js";
import { streamWithRetry } from "../transport/anthropic.js";
import { runApp } from "../tui/app.js";
import { runHook, logHookResult } from "../core/hooks.js";
import { openMemoryDb, storeSessionMeta } from "../tools/memory.js";
import type { SessionState } from "../core/policies.js";
import { parseArgs, versionString } from "./args.js";
import { openStore, pickSession } from "./session.js";
import type { RunDeps } from "./io.js";
import { runHeadless, runRepl } from "./io.js";

export { parseArgs, versionString } from "./args.js";

function findHaikuPricing(
  pricing: Record<string, ModelPricing>,
): Partial<ModelPricing> | undefined {
  for (const [key, val] of Object.entries(pricing)) {
    if (key.toLowerCase().includes("haiku")) return val;
  }
  return undefined;
}

function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

function setupDeps(args: ReturnType<typeof parseArgs>) {
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
  const workspaceRoot = appConfig.confineToWorkspace
    ? (findGitRoot(cwd) ?? cwd)
    : undefined;

  const interactiveTty = process.stdin.isTTY && process.stdout.isTTY;
  const store =
    args.continue_ && args.prompt === undefined && interactiveTty
      ? pickSession(cwd)
      : openStore(cwd, args.continue_);

  return {
    appConfig,
    config,
    pricing,
    cwd,
    store,
    interactiveTty,
    workspaceRoot,
  };
}

function setupRegistry(
  skills: ReturnType<typeof discoverSkills>,
  memoryDb: ReturnType<typeof openMemoryDb>,
  sessionState: SessionState,
  config: ReturnType<typeof loadAppConfig>["transport"],
  stream: ReturnType<typeof streamWithRetry>,
  appConfig: ReturnType<typeof loadAppConfig>,
  args: ReturnType<typeof parseArgs>,
  workspaceRoot?: string,
) {
  const registry = createRegistry(skills, memoryDb, sessionState, {
    config,
    stream,
    cwd: process.cwd(),
    maxToolResultChars: appConfig.maxToolResultChars,
    workspaceRoot,
  });

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

  if (appConfig.progressiveTools) {
    registry.setActive(CORE_TOOLS);
  }

  return registry;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) {
    process.stdout.write(versionString() + "\n");
    return;
  }

  const {
    appConfig,
    config,
    pricing,
    cwd,
    store,
    interactiveTty,
    workspaceRoot,
  } = setupDeps(args);
  const resolvedStore = await (store instanceof Promise
    ? store
    : Promise.resolve(store));
  const skills = discoverSkills(homedir(), findGitRoot(cwd));
  const memoryDb = openMemoryDb(homedir());
  const sessionState: SessionState = {
    pagedOutputs: new Map(),
    readCache: new Map(),
  };
  const stream = streamWithRetry(config);
  const registry = setupRegistry(
    skills,
    memoryDb,
    sessionState,
    config,
    stream,
    appConfig,
    args,
    workspaceRoot,
  );

  const system = buildSystemPrompt(
    cwd,
    config.model,
    loadInstructions(cwd, homedir()),
    formatAvailableSkills(skills),
    getGitContext(cwd),
    registry.deferredTools(),
  );
  const ledger = new CacheLedger();
  const hooks = appConfig.hooks;

  const deps: RunDeps = {
    cwd,
    store: resolvedStore,
    registry,
    config,
    system,
    ledger,
    pricing,
    stream,
    hooks,
    sessionState,
    maxToolResultChars: appConfig.maxToolResultChars,
    autoCompactAtTokens: appConfig.autoCompactAtTokens,
    cachePrewarmIdleMs: appConfig.cachePrewarmIdleMs,
  };

  const sessionStartResults = await runHook(
    "session_start",
    hooks.sessionStart,
    resolvedStore.sessionId,
    cwd,
  );
  if (sessionStartResults) {
    for (const r of sessionStartResults) {
      logHookResult("session_start", r, console.error);
    }
  }

  let sessionEndFired = false;
  async function fireSessionEnd(): Promise<void> {
    if (sessionEndFired) return;
    sessionEndFired = true;
    const results = await runHook(
      "session_end",
      hooks.sessionEnd,
      resolvedStore.sessionId,
      cwd,
    );
    if (results) {
      for (const r of results) logHookResult("session_end", r, console.error);
    }
    try {
      storeSessionMeta(
        memoryDb,
        resolvedStore.path,
        cwd,
        findHaikuPricing(pricing),
      );
    } catch {
      // best-effort
    }
  }

  function restoreTerminal(): void {
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch {
      // stdin may already be closed
    }
    process.stdout.write("\x1b[?25h");
  }

  function signalExit(): void {
    fireSessionEnd()
      .then(() => {
        restoreTerminal();
        process.exit(0);
      })
      .catch(() => {
        restoreTerminal();
        process.exit(0);
      });
  }
  process.once("SIGINT", signalExit);
  process.once("SIGTERM", signalExit);

  if (args.prompt !== undefined) {
    await runHeadless(deps, args.prompt, args.json, args.yolo);
    return;
  }

  if (interactiveTty) {
    await runApp({
      cwd,
      store: resolvedStore,
      registry,
      config,
      system,
      pricing,
      autoCompactAtTokens: appConfig.autoCompactAtTokens,
      hooks,
      sessionState,
      maxToolResultChars: appConfig.maxToolResultChars,
      cachePrewarmIdleMs: appConfig.cachePrewarmIdleMs,
    });
    await fireSessionEnd();
    return;
  }

  await runRepl(deps, args.json, args.yolo);
  await fireSessionEnd();
}

if (isDirectEntry()) {
  main().catch((err: unknown) => {
    console.error(
      `stackpilot: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  });
}
