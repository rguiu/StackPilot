// Runtime config from environment. Fail fast on missing credentials.
//
// API key resolution: $ANTHROPIC_API_KEY, else the `env` block of
// ~/.claude/settings.json (documented convenience — same key Claude Code
// uses). Never persisted, never logged.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TransportConfig } from "./transport/anthropic.js";

export const DEFAULT_MODEL = "claude-haiku-4-5";

export class ConfigError extends Error {}

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
  };
}
