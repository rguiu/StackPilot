// Tool registry: fixed order (stable API prefix), schema projection for the
// Messages API, and dispatch.

import { editTool, readTool, writeTool } from "./fs.js";
import { patchTool } from "./patch.js";
import { bashTool } from "./shell.js";
import { globTool, grepTool } from "./search.js";
import { searchHistoryTool } from "./history.js";
import { createTodoTool, type TodoItem } from "./todo.js";
import { createSkillTool, type SkillInfo } from "./skill.js";
import { createSearchMemoryTool, createSearchFilesTool } from "./memory.js";
import { createReadMoreTool } from "./readmore.js";
import { createAgentTool, type AgentState } from "./agent.js";
import type { SessionState } from "../core/policies.js";
import type {
  TransportConfig,
  StreamResult,
  MessagesRequest,
} from "../transport/anthropic.js";
import { ToolInputError, type ToolDef, type ToolResult } from "./types.js";

export interface Registry {
  defs: readonly ToolDef[];
  todoState: { todos: TodoItem[] };
  schemas(): { name: string; description: string; input_schema: unknown }[];
  get(name: string): ToolDef | undefined;
  setEnabled(names: readonly string[] | null): void;
  isEnabled(name: string): boolean;
  enabledNames(): string[];
}

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

  const registry: Registry = {
    defs,
    todoState,
    schemas() {
      return defs
        .filter((d) => enabled === null || enabled.has(d.name))
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
      return enabled === null ? byName.has(name) : enabled.has(name);
    },
    enabledNames() {
      return defs
        .filter((d) => enabled === null || enabled.has(d.name))
        .map((d) => d.name);
    },
  };

  if (agentCfg) {
    const agentState: AgentState = {
      registry,
      config: agentCfg.config,
      stream: agentCfg.stream,
      cwd: agentCfg.cwd,
      sessionState,
      maxToolResultChars: agentCfg.maxToolResultChars,
    };
    const agentTool = createAgentTool(agentState);
    defs.push(agentTool);
    byName.set("Agent", agentTool);
  }

  return registry;
}

export async function executeTool(
  def: ToolDef,
  input: Record<string, unknown>,
  cwd: string,
): Promise<ToolResult> {
  try {
    return await def.execute(input, cwd);
  } catch (err) {
    if (err instanceof ToolInputError) {
      return { output: `invalid input: ${err.message}`, isError: true };
    }
    throw err;
  }
}
