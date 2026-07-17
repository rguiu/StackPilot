// Tool contract. Schemas stay Claude-familiar (models are trained on these
// shapes — see PLAN.md #9); implementations are ours.

export interface ToolResult {
  output: string;
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  // true → runs without a permission prompt (read-only tools)
  readOnly: boolean;
  execute(input: Record<string, unknown>, cwd: string): Promise<ToolResult>;
}

export class ToolInputError extends Error {}

export function requireString(
  input: Record<string, unknown>,
  key: string,
): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolInputError(`"${key}" must be a non-empty string`);
  }
  return value;
}

export function optionalString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new ToolInputError(`"${key}" must be a string`);
  }
  return value;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} of ${text.length} chars]`;
}
