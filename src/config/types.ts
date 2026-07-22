import type { TransportConfig } from "../transport/anthropic.js";
import type { HookConfig } from "../core/hooks.js";

export class ConfigError extends Error {}

export const DEFAULT_MODEL = "claude-haiku-4-5";
export const DEFAULT_AUTO_COMPACT_AT_TOKENS = 160_000;
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 10_000;

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
  confineToWorkspace: boolean;
  progressiveTools: boolean;
}
