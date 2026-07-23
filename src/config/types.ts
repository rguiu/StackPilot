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
// Maximum tool-use iterations per turn (main loop). Guards against unbounded
// loops in autonomous mode. Tune up for complex multi-objective tasks.
export const DEFAULT_MAX_ITERATIONS = 200;
// Maximum iterations for subagent exploration. Subagents are read-only and
// cheaper per-turn but should still be bounded. TODO: evaluate real-world
// subagent session lengths to pick a better default.
export const DEFAULT_SUBAGENT_MAX_ITERATIONS = 80;

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
  // Maximum tool-use iterations per turn in the main loop. Default 200.
  maxIterations: number;
  // Maximum iterations for subagent exploration. Default 80.
  subagentMaxIterations: number;
}
