// Subagent: isolated context sidechain. Shares the transport and tool
// registry with the parent but runs in its own message array. Ephemeral
// turns — not stored in the session tree.

import { toolUses, accumulateUsage, textOf } from "../util/message.js";
import type { ContentBlock, ToolResultBlock } from "../types.js";
import type { Registry } from "../tools/index.js";
import { executeTool } from "../tools/index.js";
import type {
  MessagesRequest,
  StreamResult,
  TransportConfig,
} from "../transport/anthropic.js";
import {
  pageToolResults,
  deduplicateReadResult,
  evictOldResults,
  type SessionState,
} from "./policies.js";

export interface SubagentConfig {
  description: string;
  prompt: string;
  subagentType?: "explore" | "general";
  model?: string;
}

export interface SubagentResult {
  text: string;
  toolCalls: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
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

function pickTools(registry: Registry, type: string): unknown[] {
  // Subagents are ephemeral (no prompt caching), so progressive tool loading
  // gives them no benefit and must not narrow their toolset. Build from every
  // ALLOWED tool, ignoring the parent's active set.
  const allowed = registry.defs
    .filter((d) => registry.isEnabled(d.name))
    .map((d) => ({
      name: d.name,
      description: d.description,
      input_schema: d.inputSchema,
    }));
  if (type === "explore") {
    return allowed.filter((t) =>
      ["Read", "Grep", "Glob", "SearchMemory", "SearchFiles"].includes(t.name),
    );
  }
  return allowed;
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
  signal: AbortSignal | undefined,
  onText: ((d: string) => void) | undefined,
  cwd: string,
  sessionState?: SessionState,
  maxToolResultChars?: number,
): Promise<SubagentResult> {
  const subConfig = sub.model ? { ...config, model: sub.model } : config;
  const system =
    sub.subagentType === "explore" ? EXPLORE_SYSTEM : GENERAL_SYSTEM;
  const tools = pickTools(registry, sub.subagentType ?? "general");

  const messages: { role: "user" | "assistant"; content: ContentBlock[] }[] = [
    { role: "user", content: [{ type: "text", text: sub.prompt }] },
  ];

  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  let toolCalls = 0;
  let abort: string | null = null;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    let view = messages;
    if (sessionState) {
      if (maxToolResultChars && maxToolResultChars > 0) {
        view = pageToolResults(view, sessionState, maxToolResultChars);
      }
      view = evictOldResults(view);
    }

    const result = await stream(
      subConfig,
      {
        system: [{ type: "text", text: system }],
        tools,
        messages: view,
      },
      onText ?? (() => {}),
      signal,
    );

    accumulateUsage(usage, result.usage);

    messages.push({ role: "assistant", content: result.content });

    const uses = toolUses(result.content);
    if (result.stopReason !== "tool_use" || uses.length === 0) break;

    const results: ToolResultBlock[] = [];
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
      const toolResult = await executeTool(def, use.input, cwd);
      let output = toolResult.output;
      if (use.name === "Read" && !toolResult.isError && sessionState) {
        const filePath = use.input.file_path as string;
        if (filePath && typeof output === "string") {
          output = deduplicateReadResult(filePath, output, sessionState);
        }
      }
      results.push({
        tool_use_id: use.id,
        type: "tool_result",
        content: output,
        ...(toolResult.isError === true ? { is_error: true } : {}),
      });
    }

    messages.push({
      role: "user",
      content: results,
    });
  }

  let text = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "assistant" && Array.isArray(msg.content)) {
      text = textOf(msg.content).trim();
      if (text) break;
    }
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
