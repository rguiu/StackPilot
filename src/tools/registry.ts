import type { ToolDef } from "./types.js";
import type { TodoItem } from "./todo.js";

export interface Registry {
  defs: readonly ToolDef[];
  todoState: { todos: TodoItem[] };
  workspaceRoot: string | undefined;
  schemas(): { name: string; description: string; input_schema: unknown }[];
  get(name: string): ToolDef | undefined;
  setEnabled(names: readonly string[] | null): void;
  isEnabled(name: string): boolean;
  enabledNames(): string[];
  setActive(names: readonly string[] | null): void;
  activate(name: string): boolean;
  deferredTools(): { name: string; description: string }[];
}
