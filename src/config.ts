// Runtime config: environment (credentials, model, base URL) + optional
// TOML file (~/.stackpilot/config.toml or $STACKPILOT_CONFIG) for pricing,
// tool defaults, and compaction threshold. Fail fast on malformed config;
// a missing file is fine (defaults apply).
//
// API key resolution: $ANTHROPIC_API_KEY, else the `env` block of
// ~/.claude/settings.json (documented convenience — same key Claude Code
// uses). Never persisted, never logged.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { TransportConfig, RetryConfig } from "./transport/anthropic.js";
import { DEFAULT_RETRY } from "./transport/anthropic.js";
import type { HookConfig } from "./core/hooks.js";

export const DEFAULT_MODEL = "claude-haiku-4-5";
export const DEFAULT_AUTO_COMPACT_AT_TOKENS = 160_000;
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 10_000;

export class ConfigError extends Error {}

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheInputPerMTok?: number;
  cacheWritePerMTok?: number;
}

export interface AppConfig {
  transport: TransportConfig;
  pricing: Record<string, ModelPricing>;
  enabledTools: string[] | null;
  autoCompactAtTokens: number;
  hooks: {
    preTool?: HookConfig;
    postTool?: HookConfig;
    sessionStart?: HookConfig;
    sessionEnd?: HookConfig;
    preCompact?: HookConfig;
    postCompact?: HookConfig;
  };
  maxToolResultChars: number;
}

export function configPath(
  env: NodeJS.ProcessEnv,
  home: string = homedir(),
): string {
  return env.STACKPILOT_CONFIG ?? join(home, ".stackpilot", "config.toml");
}

function claudeSettingsKey(home: string): string | null {
  try {
    const raw = readFileSync(join(home, ".claude", "settings.json"), "utf8");
    const parsed = JSON.parse(raw) as { env?: Record<string, string> };
    return parsed.env?.ANTHROPIC_API_KEY ?? null;
  } catch {
    return null;
  }
}

export function resolveConfig(
  env: NodeJS.ProcessEnv,
  overrides: { model?: string } = {},
  home: string = homedir(),
): TransportConfig {
  const apiKey = env.ANTHROPIC_API_KEY ?? claudeSettingsKey(home);
  if (!apiKey) {
    throw new ConfigError(
      "no API key: set ANTHROPIC_API_KEY or add it to the env block of ~/.claude/settings.json",
    );
  }
  return {
    baseUrl: (env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(
      /\/$/,
      "",
    ),
    apiKey,
    model:
      overrides.model ??
      env.STACKPILOT_MODEL ??
      env.ANTHROPIC_MODEL ??
      DEFAULT_MODEL,
    maxTokens: 8192,
    retry: DEFAULT_RETRY,
    cheapModel: env.STACKPILOT_CHEAP_MODEL ?? undefined,
    thinkingBudgetTokens: env.STACKPILOT_THINKING_BUDGET
      ? parseInt(env.STACKPILOT_THINKING_BUDGET, 10)
      : undefined,
  };
}

// --- TOML file --------------------------------------------------------------

function readTomlFile(path: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null; // missing file is not an error
  }
  try {
    return parseToml(raw);
  } catch (err) {
    throw new ConfigError(`invalid TOML in ${path}: ${(err as Error).message}`);
  }
}

function asFiniteNumber(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError(`${where} must be a finite number`);
  }
  return value;
}

function parsePricing(
  raw: unknown,
  path: string,
): Record<string, ModelPricing> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`[pricing] must be a table in ${path}`);
  }
  const out: Record<string, ModelPricing> = {};
  for (const [model, rates] of Object.entries(raw)) {
    const r = rates as Record<string, unknown>;
    const where = `[pricing."${model}"]`;
    out[model] = {
      inputPerMTok: asFiniteNumber(r.inputPerMTok, `${where}.inputPerMTok`),
      outputPerMTok: asFiniteNumber(r.outputPerMTok, `${where}.outputPerMTok`),
      ...(r.cacheInputPerMTok !== undefined && {
        cacheInputPerMTok: asFiniteNumber(
          r.cacheInputPerMTok,
          `${where}.cacheInputPerMTok`,
        ),
      }),
      ...(r.cacheWritePerMTok !== undefined && {
        cacheWritePerMTok: asFiniteNumber(
          r.cacheWritePerMTok,
          `${where}.cacheWritePerMTok`,
        ),
      }),
    };
  }
  return out;
}

function parseEnabledTools(raw: unknown, path: string): string[] | null {
  if (raw === undefined) return null;
  const tools = (raw as Record<string, unknown>).enabled;
  if (tools === undefined) return null;
  if (!Array.isArray(tools) || tools.some((t) => typeof t !== "string")) {
    throw new ConfigError(
      `[tools].enabled must be an array of strings in ${path}`,
    );
  }
  return tools as string[];
}

function parseRetry(raw: unknown, path: string): RetryConfig | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`[retry] must be a table in ${path}`);
  }
  const r = raw as Record<string, unknown>;
  const config: RetryConfig = { ...DEFAULT_RETRY };
  if (r.maxRetries !== undefined) {
    config.maxRetries = asFiniteNumber(r.maxRetries, "[retry].maxRetries");
  }
  if (r.baseDelayMs !== undefined) {
    config.baseDelayMs = asFiniteNumber(r.baseDelayMs, "[retry].baseDelayMs");
  }
  if (r.maxDelayMs !== undefined) {
    config.maxDelayMs = asFiniteNumber(r.maxDelayMs, "[retry].maxDelayMs");
  }
  return config;
}

function parseHooks(
  raw: unknown,
  path: string,
): {
  preTool?: HookConfig;
  postTool?: HookConfig;
  sessionStart?: HookConfig;
  sessionEnd?: HookConfig;
  preCompact?: HookConfig;
  postCompact?: HookConfig;
} {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`[hooks] must be a table in ${path}`);
  }
  const h = raw as Record<string, unknown>;
  const out: {
    preTool?: HookConfig;
    postTool?: HookConfig;
    sessionStart?: HookConfig;
    sessionEnd?: HookConfig;
    preCompact?: HookConfig;
    postCompact?: HookConfig;
  } = {};

  function parseOne(
    key: string,
    target:
      | "preTool"
      | "postTool"
      | "sessionStart"
      | "sessionEnd"
      | "preCompact"
      | "postCompact",
  ): void {
    const section = h[key] as Record<string, unknown> | undefined;
    if (section === undefined) return;
    const command = section.command;
    if (
      typeof command !== "string" &&
      (!Array.isArray(command) ||
        command.length === 0 ||
        command.some((c) => typeof c !== "string"))
    ) {
      throw new ConfigError(
        `[hooks.${key}].command must be a non-empty string or array of strings`,
      );
    }
    out[target] = {
      command: command as string | string[],
      timeoutMs:
        section.timeoutMs !== undefined
          ? asFiniteNumber(section.timeoutMs, `[hooks.${key}].timeoutMs`)
          : 5000,
    };
  }

  parseOne("pre_tool", "preTool");
  parseOne("post_tool", "postTool");
  parseOne("session_start", "sessionStart");
  parseOne("session_end", "sessionEnd");
  parseOne("pre_compact", "preCompact");
  parseOne("post_compact", "postCompact");

  return out;
}

export function loadAppConfig(
  env: NodeJS.ProcessEnv,
  overrides: { model?: string } = {},
  home: string = homedir(),
): AppConfig {
  const transport = resolveConfig(env, overrides, home);
  const path = configPath(env, home);
  const file = readTomlFile(path) ?? {};

  const autoRaw = file.autoCompactAtTokens;
  const autoCompactAtTokens =
    autoRaw === undefined
      ? DEFAULT_AUTO_COMPACT_AT_TOKENS
      : asFiniteNumber(autoRaw, "autoCompactAtTokens");
  if (autoCompactAtTokens < 0) {
    throw new ConfigError("autoCompactAtTokens must be >= 0 (0 disables)");
  }

  const retryOverride = parseRetry(file.retry, path);
  if (retryOverride) transport.retry = retryOverride;

  if (typeof file.cheapModel === "string" && file.cheapModel.length > 0) {
    transport.cheapModel = file.cheapModel;
  }

  if (typeof file.thinkingBudgetTokens === "number") {
    transport.thinkingBudgetTokens = file.thinkingBudgetTokens;
  }

  const maxRaw = file.maxToolResultChars;
  const maxToolResultChars =
    maxRaw === undefined
      ? DEFAULT_MAX_TOOL_RESULT_CHARS
      : asFiniteNumber(maxRaw, "maxToolResultChars");

  return {
    transport,
    pricing: parsePricing(file.pricing, path),
    enabledTools: parseEnabledTools(file.tools, path),
    autoCompactAtTokens,
    hooks: parseHooks(file.hooks, path),
    maxToolResultChars,
  };
}

// Merge a patch into the TOML file (parse → merge → stringify). Creates the
// file/directory when missing. NOTE: rewriting loses comments in the file —
// documented v1 tradeoff.
export function saveConfigPatch(
  patch: { enabledTools?: string[]; autoCompactAtTokens?: number },
  env: NodeJS.ProcessEnv,
  home: string = homedir(),
): string {
  const path = configPath(env, home);
  const current = readTomlFile(path) ?? {};

  if (patch.enabledTools !== undefined) {
    const tools = (current.tools ?? {}) as Record<string, unknown>;
    tools.enabled = patch.enabledTools;
    current.tools = tools;
  }
  if (patch.autoCompactAtTokens !== undefined) {
    current.autoCompactAtTokens = patch.autoCompactAtTokens;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyToml(current) + "\n", "utf8");
  return path;
}
