// Tool registry: fixed order (stable API prefix), schema projection for the
// Messages API, and dispatch.

import { editTool, readTool, writeTool } from "./fs.js";
import { patchTool } from "./patch.js";
import { bashTool } from "./shell.js";
import { globTool, grepTool } from "./search.js";
import { searchHistoryTool } from "./history.js";
import { webFetchTool } from "./webfetch.js";
import { createTodoTool, type TodoItem } from "./todo.js";
import { createSkillTool, type SkillInfo } from "./skill.js";
import { createSearchMemoryTool, createSearchFilesTool } from "./memory.js";
import { createReadMoreTool } from "./readmore.js";
import { createAgentTool } from "./agent.js";
import type { SessionState } from "../core/policies.js";
import type {
  TransportConfig,
  StreamResult,
  MessagesRequest,
} from "../transport/anthropic.js";
import { ToolInputError, type ToolDef, type ToolResult } from "./types.js";
import type { Registry } from "./registry.js";

export type { Registry } from "./registry.js";

// The exploration core: the tools a session almost always needs first. With
// progressive loading on, only these ship full schemas at startup; the rest
// are advertised by name in the system prompt and activated on first use.
export const CORE_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];

export function unknownToolNames(
  registry: Registry,
  names: readonly string[],
): string[] {
  const valid = new Set(registry.defs.map((d) => d.name));
  return names.filter((n) => !valid.has(n));
}

type StreamFn = (
  cfg: TransportConfig,
  req: MessagesRequest,
  onText: (d: string) => void,
  signal?: AbortSignal,
) => Promise<StreamResult>;

export function createRegistry(
  skills?: Map<string, SkillInfo>,
  memoryDb?: import("better-sqlite3").Database,
  sessionState?: SessionState,
  agentCfg?: {
    config: TransportConfig;
    stream: StreamFn;
    cwd?: string;
    maxToolResultChars?: number;
    workspaceRoot?: string;
  },
): Registry {
  const todoState = { todos: [] as TodoItem[] };
  const defs: ToolDef[] = [
    readTool,
    writeTool,
    editTool,
    patchTool,
    bashTool,
    grepTool,
    globTool,
    webFetchTool,
    createTodoTool(todoState),
    searchHistoryTool,
  ];
  if (skills && skills.size > 0) {
    defs.push(createSkillTool(skills));
  }
  if (memoryDb) {
    defs.push(createSearchMemoryTool(memoryDb));
    defs.push(createSearchFilesTool(memoryDb));
  }
  if (sessionState) {
    defs.push(createReadMoreTool(sessionState));
  }

  const byName = new Map(defs.map((d) => [d.name, d]));
  let enabled: ReadonlySet<string> | null = null;
  let active: ReadonlySet<string> | null = null;
  const workspaceRoot = agentCfg?.workspaceRoot;

  const isAllowed = (name: string): boolean =>
    enabled === null || enabled.has(name);
  const isActive = (name: string): boolean =>
    active === null || active.has(name);

  const registry: Registry = {
    defs,
    todoState,
    workspaceRoot,
    schemas() {
      return defs
        .filter((d) => isAllowed(d.name) && isActive(d.name))
        .map((d) => ({
          name: d.name,
          description: d.description,
          input_schema: d.inputSchema,
        }));
    },
    get(name) {
      return byName.get(name);
    },
    setEnabled(names) {
      enabled = names === null ? null : new Set(names);
    },
    isEnabled(name) {
      return isAllowed(name);
    },
    enabledNames() {
      return defs.filter((d) => isAllowed(d.name)).map((d) => d.name);
    },
    setActive(names) {
      active = names === null ? null : new Set(names);
    },
    activate(name) {
      if (active === null) return false; // everything already active
      if (!byName.has(name) || !isAllowed(name) || active.has(name))
        return false;
      active = new Set(active).add(name);
      return true;
    },
    deferredTools() {
      const activeSet = active;
      if (activeSet === null) return [];
      return defs
        .filter((d) => isAllowed(d.name) && !activeSet.has(d.name))
        .map((d) => ({ name: d.name, description: d.description }));
    },
  };

  if (agentCfg) {
    const agentTool = createAgentTool({
      getRegistry: () => registry,
      config: agentCfg.config,
      stream: agentCfg.stream,
      cwd: agentCfg.cwd,
      sessionState,
      maxToolResultChars: agentCfg.maxToolResultChars,
    });
    defs.push(agentTool);
    byName.set("Agent", agentTool);
  }

  return registry;
}

export async function executeTool(
  def: ToolDef,
  input: Record<string, unknown>,
  cwd: string,
  workspaceRoot?: string,
): Promise<ToolResult> {
  try {
    return await def.execute(input, cwd, workspaceRoot);
  } catch (err) {
    if (err instanceof ToolInputError) {
      return { output: `invalid input: ${err.message}`, isError: true };
    }
    // Any other exception (EACCES/ENOSPC from a write, a malformed upstream
    // response, an unexpected throw in tool code) becomes a clean error
    // result. Letting it escape here would abort the whole turn — and the
    // tool_use block would be left without its required tool_result sibling.
    return {
      output: `tool "${def.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}
