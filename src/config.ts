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
  // When true, file tools (Read/Write/Edit/Patch/Grep/Glob) refuse paths
  // outside the workspace root (git root, else cwd). Off by default to keep
  // out-of-repo reads working; opt in for untrusted/autonomous runs.
  confineToWorkspace: boolean;
  // When true, sessions start with only the core exploration tools' schemas
  // (Read/Grep/Glob); other allowed tools are advertised by name in the system
  // prompt and their schemas activate on first use. Shrinks the cached tool
  // prefix at cold start. Off by default.
  progressiveTools: boolean;
}

export function configPath(
  env: NodeJS.ProcessEnv,
  home: string = homedir(),
): string {
  return env.STACKPILOT_CONFIG ?? join(home, ".stackpilot", "config.toml");
}

// Claude Code stores its provider config (API key, Bedrock switch, region,
// model ids) in the `env` block of ~/.claude/settings.json — NOT as real
// environment variables. Interactive shells don't read that file, so a user
// who configured Bedrock only there would otherwise reach us with none of it
// set (→ default model, 400 from Bedrock). We read the whole block.
export function claudeSettingsEnv(home: string): Record<string, string> {
  try {
    const raw = readFileSync(join(home, ".claude", "settings.json"), "utf8");
    const parsed = JSON.parse(raw) as { env?: Record<string, unknown> };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed.env ?? {})) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

// Effective environment: real process env wins over settings.json (an
// explicitly exported var always overrides the stored default).
export function effectiveEnv(
  env: NodeJS.ProcessEnv,
  home: string,
): NodeJS.ProcessEnv {
  return { ...claudeSettingsEnv(home), ...env };
}

// Bedrock is enabled by CLAUDE_CODE_USE_BEDROCK (the same switch Claude Code
// uses) being set to a truthy value.
export function useBedrock(env: NodeJS.ProcessEnv): boolean {
  const v = env.CLAUDE_CODE_USE_BEDROCK;
  return (
    v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false"
  );
}

// A Bedrock inference-profile id (or ARN) is passed to /model/<id> verbatim.
// We recognize them by their region-prefixed "<region>.anthropic.…" shape or
// an ARN, so a real id is never rewritten.
function looksLikeBedrockId(model: string): boolean {
  return (
    model.startsWith("arn:") ||
    /^[a-z]{2,4}\.anthropic\./.test(model) ||
    model.startsWith("anthropic.")
  );
}

// Resolve a model name to a Bedrock inference-profile id. Claude Code exports
// ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL with the full ids. We map by
// FAMILY — any name mentioning opus/sonnet/haiku (e.g. the bare alias "haiku",
// "opus", or the default "claude-haiku-4-5") onto the matching env id. This is
// deliberately loose: a Bedrock endpoint rejects a non-Bedrock id with a 400,
// so we must not pass an Anthropic-style name like "claude-haiku-4-5" through.
export function resolveBedrockModel(
  requested: string,
  env: NodeJS.ProcessEnv,
): string {
  // Already a Bedrock id/ARN — use as-is.
  if (looksLikeBedrockId(requested)) return requested;

  const name = requested.toLowerCase();
  const families: [test: string, id: string | undefined][] = [
    ["opus", env.ANTHROPIC_DEFAULT_OPUS_MODEL],
    ["sonnet", env.ANTHROPIC_DEFAULT_SONNET_MODEL],
    ["haiku", env.ANTHROPIC_DEFAULT_HAIKU_MODEL],
  ];
  for (const [test, id] of families) {
    if (name.includes(test) && id) return id;
  }
  // No family match and not a Bedrock id: fall back to the configured Haiku id
  // if we have one (never a bare Anthropic alias, which Bedrock would reject).
  return env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? requested;
}

export function resolveConfig(
  processEnv: NodeJS.ProcessEnv,
  overrides: { model?: string } = {},
  home: string = homedir(),
): TransportConfig {
  // Merge in the ~/.claude/settings.json env block (Bedrock switch, region,
  // model ids, API key) so a user who configured Claude Code there — but never
  // exported those as shell vars — is picked up. Real env vars still win.
  const env = effectiveEnv(processEnv, home);
  const bedrock = useBedrock(env);

  // Bedrock auth is handled by AWS (or the signing proxy), so no API key is
  // required. In direct-Anthropic mode a key is mandatory.
  const apiKey = env.ANTHROPIC_API_KEY ?? "";
  if (!bedrock && !apiKey) {
    throw new ConfigError(
      "no API key: set ANTHROPIC_API_KEY or add it to the env block of ~/.claude/settings.json",
    );
  }

  const requestedModel =
    overrides.model ??
    env.STACKPILOT_MODEL ??
    env.ANTHROPIC_MODEL ??
    DEFAULT_MODEL;

  if (bedrock) {
    const baseUrl = (
      env.ANTHROPIC_BEDROCK_BASE_URL ??
      `https://bedrock-runtime.${env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1"}.amazonaws.com`
    ).replace(/\/$/, "");
    return {
      baseUrl,
      apiKey,
      model: resolveBedrockModel(requestedModel, env),
      maxTokens: 8192,
      retry: DEFAULT_RETRY,
      provider: "bedrock",
      region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION,
      cheapModel: env.STACKPILOT_CHEAP_MODEL
        ? resolveBedrockModel(env.STACKPILOT_CHEAP_MODEL, env)
        : env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      thinkingBudgetTokens: env.STACKPILOT_THINKING_BUDGET
        ? parseInt(env.STACKPILOT_THINKING_BUDGET, 10)
        : undefined,
    };
  }

  return {
    baseUrl: (env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(
      /\/$/,
      "",
    ),
    apiKey,
    model: requestedModel,
    maxTokens: 8192,
    retry: DEFAULT_RETRY,
    provider: "anthropic",
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

  const confineRaw = file.confineToWorkspace;
  if (confineRaw !== undefined && typeof confineRaw !== "boolean") {
    throw new ConfigError("confineToWorkspace must be a boolean");
  }
  const confineToWorkspace = confineRaw === true;

  const progRaw = file.progressiveTools;
  if (progRaw !== undefined && typeof progRaw !== "boolean") {
    throw new ConfigError("progressiveTools must be a boolean");
  }
  const progressiveTools = progRaw === true;

  return {
    transport,
    pricing: parsePricing(file.pricing, path),
    enabledTools: parseEnabledTools(file.tools, path),
    autoCompactAtTokens,
    hooks: parseHooks(file.hooks, path),
    maxToolResultChars,
    confineToWorkspace,
    progressiveTools,
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
