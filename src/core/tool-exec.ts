import { executeTool, type Registry } from "../tools/index.js";
import { deduplicateReadResult, type SessionState } from "./policies.js";
import type { ToolResultBlock } from "../types.js";
import type { TurnStats } from "./loop.js";

export interface ToolValidation {
  valid: true;
  def: NonNullable<ReturnType<Registry["get"]>>;
  activated: boolean;
}

export interface ToolValidationError {
  valid: false;
  output: string;
}

export function validateToolUse(
  registry: Registry,
  name: string,
  stats: TurnStats,
): ToolValidation | ToolValidationError {
  const def = registry.get(name);
  stats.toolCalls++;

  if (!def) {
    return { valid: false, output: `unknown tool: ${name}` };
  }
  if (!registry.isEnabled(name)) {
    return { valid: false, output: `tool disabled for this session: ${name}` };
  }

  let activated = false;
  if (registry.activate(name)) {
    activated = true;
    stats.notes.push(`activated tool schema: ${name}`);
  }

  return { valid: true, def, activated };
}

export async function executeToolWithPolicies(
  def: NonNullable<ReturnType<Registry["get"]>>,
  input: Record<string, unknown>,
  cwd: string,
  sessionState: SessionState | undefined,
  workspaceRoot?: string,
): Promise<{ output: string; isError: boolean }> {
  const result = await executeTool(def, input, cwd, workspaceRoot);
  let output = result.output;
  const isError = result.isError === true;

  if (def.name === "Read" && !isError && sessionState) {
    const filePath = input.file_path as string;
    if (filePath && typeof output === "string") {
      output = deduplicateReadResult(filePath, output, sessionState);
    }
  }

  return { output, isError };
}

export function makeToolResult(
  toolUseId: string,
  output: string,
  isError: boolean,
): ToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: output,
    ...(isError ? { is_error: true as const } : {}),
  };
}
