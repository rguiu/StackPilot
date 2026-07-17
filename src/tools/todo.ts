// TodoWrite: session-scoped task list. Pure state holder + formatter; the
// REPL prints it after updates. High steering value per token (PLAN #13).

import { type ToolDef, type ToolResult } from "./types.js";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

const VALID_STATUS = new Set(["pending", "in_progress", "completed"]);

export function formatTodos(todos: readonly TodoItem[]): string {
  if (todos.length === 0) return "(empty)";
  const mark = { pending: "[ ]", in_progress: "[~]", completed: "[x]" };
  return todos.map((t) => `${mark[t.status]} ${t.content}`).join("\n");
}

export function createTodoTool(state: { todos: TodoItem[] }): ToolDef {
  return {
    name: "TodoWrite",
    description:
      "Replace the session todo list. Use for multi-step tasks; keep statuses current.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
    async execute(input): Promise<ToolResult> {
      const raw = input.todos;
      if (!Array.isArray(raw)) {
        return { output: '"todos" must be an array', isError: true };
      }
      const next: TodoItem[] = [];
      for (const item of raw) {
        const rec = item as Record<string, unknown>;
        if (
          typeof rec.content !== "string" ||
          typeof rec.status !== "string" ||
          !VALID_STATUS.has(rec.status)
        ) {
          return {
            output:
              "each todo needs {content: string, status: pending|in_progress|completed}",
            isError: true,
          };
        }
        next.push({
          content: rec.content,
          status: rec.status as TodoItem["status"],
        });
      }
      state.todos = next;
      return { output: `todos updated:\n${formatTodos(next)}` };
    },
  };
}
