// Subagent: isolated context sidechain. Shares the transport and tool
// registry with the parent but runs in its own message array. Ephemeral
// turns — not stored in the session tree.

import type { Registry } from "../tools/index.js";
import { executeTool } from "../tools/index.js";
import type {
  MessagesRequest,
  StreamResult,
  TransportConfig,
  UsageInfo,
} from "../transport/anthropic.js";

export interface SubagentConfig {
  description: string;
  prompt: string;
  subagentType?: "explore" | "general";
  model?: string;
}

export interface SubagentResult {
  text: string;
  toolCalls: number;
  usage: UsageInfo;
  abort: string | null;
}

const MAX_ITERATIONS = 10;

const EXPLORE_SYSTEM = [
  "You are a subagent for stackpilot, specialized in codebase exploration.",
  "Your task: answer the user's question by reading and searching the code.",
  "Rules:",
  "- Use Grep, Glob, and Read to explore. Do NOT edit or write files.",
  "- Be thorough — explore relevant files before answering.",
  "- Return a clear, structured answer. No tool calls in your final response.",
].join("\n");

const GENERAL_SYSTEM = [
  "You are a subagent for stackpilot. Complete the assigned task.",
  "Rules:",
  "- Use the provided tools to accomplish the task.",
  "- Be thorough but efficient.",
  "- Return a text result. Do NOT call tools in your final response.",
  "- If you can't complete the task, explain why.",
].join("\n");

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

function pickTools(registry: Registry, type: string): unknown[] {
  if (type === "explore") {
    return registry
      .schemas()
      .filter((t) =>
        ["Read", "Grep", "Glob", "SearchMemory", "SearchFiles"].includes(
          t.name,
        ),
      );
  }
  return registry.schemas();
}

function toolUses(content: unknown[]): ToolUseBlock[] {
  return content.filter(
    (b): b is ToolUseBlock =>
      typeof b === "object" &&
      b !== null &&
      (b as { type?: string }).type === "tool_use",
  );
}

export async function runSubagent(
  config: TransportConfig,
  registry: Registry,
  sub: SubagentConfig,
  stream: (
    cfg: TransportConfig,
    req: MessagesRequest,
    onText: (d: string) => void,
    signal?: AbortSignal,
  ) => Promise<StreamResult>,
  signal?: AbortSignal,
  onText?: (d: string) => void,
): Promise<SubagentResult> {
  const subConfig = sub.model ? { ...config, model: sub.model } : config;
  const system =
    sub.subagentType === "explore" ? EXPLORE_SYSTEM : GENERAL_SYSTEM;
  const tools = pickTools(registry, sub.subagentType ?? "general");

  const messages: { role: "user" | "assistant"; content: unknown }[] = [
    { role: "user", content: [{ type: "text", text: sub.prompt }] },
  ];

  const usage: UsageInfo = {};
  let toolCalls = 0;
  let abort: string | null = null;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const result = await stream(
      subConfig,
      {
        system: [{ type: "text", text: system }],
        tools,
        messages,
      },
      onText ?? (() => {}),
      signal,
    );

    accumulate(usage, result.usage);

    messages.push({ role: "assistant", content: result.content });

    const uses = toolUses(result.content);
    if (result.stopReason !== "tool_use" || uses.length === 0) break;

    const results: {
      tool_use_id: string;
      type: string;
      content: string;
      is_error?: boolean;
    }[] = [];
    for (const use of uses) {
      toolCalls++;
      const def = registry.get(use.name);
      if (!def) {
        results.push({
          tool_use_id: use.id,
          type: "tool_result",
          content: `unknown tool: ${use.name}`,
          is_error: true,
        });
        continue;
      }
      if (!registry.isEnabled(use.name)) {
        results.push({
          tool_use_id: use.id,
          type: "tool_result",
          content: `tool disabled: ${use.name}`,
          is_error: true,
        });
        continue;
      }
      const toolResult = await executeTool(def, use.input, process.cwd());
      results.push({
        tool_use_id: use.id,
        type: "tool_result",
        content: toolResult.output,
        is_error: toolResult.isError === true,
      });
    }

    messages.push({ role: "user", content: results });
  }

  const finalMsg = messages[messages.length - 1];
  let text = "";
  if (finalMsg?.role === "assistant" && Array.isArray(finalMsg.content)) {
    text = finalMsg.content
      .filter((b) => (b as { type?: string }).type === "text")
      .map((b) => (b as { text?: string }).text ?? "")
      .join("\n")
      .trim();
  }

  if (!text && signal?.aborted) {
    abort = "interrupted";
    text = "[subagent interrupted by user]";
  }

  if (!text) {
    abort = "no_text";
    text = "[subagent returned no text]";
  }

  return { text, toolCalls, usage, abort };
}

function accumulate(acc: UsageInfo, usage: UsageInfo): void {
  acc.input_tokens = (acc.input_tokens ?? 0) + (usage.input_tokens ?? 0);
  acc.output_tokens = (acc.output_tokens ?? 0) + (usage.output_tokens ?? 0);
  acc.cache_read_input_tokens =
    (acc.cache_read_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  acc.cache_creation_input_tokens =
    (acc.cache_creation_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0);
}
