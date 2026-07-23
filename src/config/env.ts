import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TransportConfig } from "../transport/anthropic.js";
import { DEFAULT_RETRY } from "../transport/anthropic.js";
import { ConfigError, DEFAULT_MODEL } from "./types.js";

export function configPath(
  env: NodeJS.ProcessEnv,
  home: string = homedir(),
): string {
  return env.STACKPILOT_CONFIG ?? join(home, ".stackpilot", "config.toml");
}

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

export function effectiveEnv(
  env: NodeJS.ProcessEnv,
  home: string,
): NodeJS.ProcessEnv {
  return { ...claudeSettingsEnv(home), ...env };
}

export function useBedrock(env: NodeJS.ProcessEnv): boolean {
  const v = env.CLAUDE_CODE_USE_BEDROCK;
  return (
    v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false"
  );
}

function looksLikeBedrockId(model: string): boolean {
  return (
    model.startsWith("arn:") ||
    /^[a-z]{2,4}\.anthropic\./.test(model) ||
    model.startsWith("anthropic.")
  );
}

export function resolveBedrockModel(
  requested: string,
  env: NodeJS.ProcessEnv,
): string {
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
  return env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? requested;
}

const ANTHROPIC_FAMILY_MODELS: Record<string, string> = {
  opus: "claude-opus-4-5",
  sonnet: "claude-sonnet-4-5",
  haiku: DEFAULT_MODEL,
};

export function normalizeAnthropicModel(model: string): string {
  if (/^claude-/.test(model)) return model;
  const name = model.toLowerCase().trim();
  for (const [family, id] of Object.entries(ANTHROPIC_FAMILY_MODELS)) {
    if (name === family) return id;
  }
  return model;
}

export function resolveConfig(
  processEnv: NodeJS.ProcessEnv,
  overrides: { model?: string } = {},
  home: string = homedir(),
): TransportConfig {
  const env = effectiveEnv(processEnv, home);
  const bedrock = useBedrock(env);

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
    model: normalizeAnthropicModel(requestedModel),
    maxTokens: 8192,
    retry: DEFAULT_RETRY,
    provider: "anthropic",
    cheapModel: env.STACKPILOT_CHEAP_MODEL
      ? normalizeAnthropicModel(env.STACKPILOT_CHEAP_MODEL)
      : undefined,
    thinkingBudgetTokens: env.STACKPILOT_THINKING_BUDGET
      ? parseInt(env.STACKPILOT_THINKING_BUDGET, 10)
      : undefined,
  };
}
