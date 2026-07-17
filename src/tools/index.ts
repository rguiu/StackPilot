// Tool registry: fixed order (stable API prefix), schema projection for the
// Messages API, and dispatch.

import { editTool, readTool, writeTool } from "./fs.js";
import { bashTool } from "./shell.js";
import { globTool, grepTool } from "./search.js";
import { createTodoTool, type TodoItem } from "./todo.js";
import { ToolInputError, type ToolDef, type ToolResult } from "./types.js";

export interface Registry {
  defs: readonly ToolDef[];
  todoState: { todos: TodoItem[] };
  schemas(): { name: string; description: string; input_schema: unknown }[];
  get(name: string): ToolDef | undefined;
}

export function createRegistry(): Registry {
  const todoState = { todos: [] as TodoItem[] };
  // Order is part of the cache prefix — append new tools at the END only.
  const defs: ToolDef[] = [
    readTool,
    writeTool,
    editTool,
    bashTool,
    grepTool,
    globTool,
    createTodoTool(todoState),
  ];
  const byName = new Map(defs.map((d) => [d.name, d]));
  return {
    defs,
    todoState,
    schemas() {
      return defs.map((d) => ({
        name: d.name,
        description: d.description,
        input_schema: d.inputSchema,
      }));
    },
    get(name) {
      return byName.get(name);
    },
  };
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
    throw err; // unexpected — let it surface, don't swallow
  }
}
