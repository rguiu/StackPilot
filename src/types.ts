// Shared content block types. Discriminated union replaces per-file `unknown`
// casts — safer refactoring, IDE autocomplete, early crash on API changes.

export type TextBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
};

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: { type: "ephemeral" };
};

export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  cache_control?: { type: "ephemeral" };
};

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export type Message = {
  role: "user" | "assistant";
  content: ContentBlock[];
};
