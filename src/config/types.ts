import type { TransportConfig } from "../transport/anthropic.js";
import type { HookConfig } from "../core/hooks.js";

export class ConfigError extends Error {}

export const DEFAULT_MODEL = "claude-haiku-4-5";
export const DEFAULT_AUTO_COMPACT_AT_TOKENS = 160_000;
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 10_000;
// 0 disables. When set, an idle gap this long (ms) before the next REPL turn
// triggers a minimal keep-alive request that refreshes the cached prefix
// before the provider's ~5-min TTL expires — trading one tiny request for a
// full prefix re-write. Off by default; a conservative on-value is ~240000.
export const DEFAULT_CACHE_PREWARM_IDLE_MS = 0;

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
  // Idle threshold (ms) before a REPL turn that triggers a cache keep-alive
  // request. 0 disables. See DEFAULT_CACHE_PREWARM_IDLE_MS.
  cachePrewarmIdleMs: number;
}
