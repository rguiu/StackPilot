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
  // Marks a tool used in the current contraction round, resetting its idle
  // counter. No-op when progressive loading is off.
  touch(name: string): void;
  // Advances the contraction round and deactivates any active, non-core tool
  // not touched within maxIdleRounds rounds. Returns the deactivated names.
  // No-op ([]) when progressive loading is off or maxIdleRounds <= 0.
  contractDisused(maxIdleRounds: number): string[];
}
