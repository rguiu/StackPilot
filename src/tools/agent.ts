// Agent tool: spawns isolated subagents for focused tasks.
// Subagents run in their own message context using the transport.

import { runSubagent } from "../core/subagent.js";
import type { Registry } from "./index.js";
import type { TransportConfig } from "../transport/anthropic.js";
import { type ToolDef, type ToolResult } from "./types.js";

export interface AgentState {
  registry: Registry;
  config: TransportConfig;
  stream: (
    cfg: TransportConfig,
    req: {
      system: unknown;
      tools: unknown[];
      messages: { role: "user" | "assistant"; content: unknown }[];
    },
    onText: (d: string) => void,
    signal?: AbortSignal,
  ) => Promise<{
    content: unknown[];
    stopReason: string | null;
    usage: { input_tokens?: number; output_tokens?: number };
    model: string | null;
  }>;
  signal?: AbortSignal;
}

export function createAgentTool(state: AgentState): ToolDef {
  return {
    name: "Agent",
    description:
      "Spawn a subagent to handle a focused task in an isolated context. " +
      "Use for codebase exploration, research that requires multiple queries, " +
      "or tasks that would bloat the main conversation. The subagent returns " +
      "a single text result.",
    readOnly: false,
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description:
            "Short description of what the subagent should do (3-5 words)",
        },
        prompt: {
          type: "string",
          description: "The task for the subagent to complete",
        },
        subagent_type: {
          type: "string",
          enum: ["explore", "general"],
          description:
            "explore = read-only tools for codebase research. general = all tools.",
        },
      },
      required: ["description", "prompt"],
    },
    async execute(input): Promise<ToolResult> {
      const description =
        typeof input.description === "string"
          ? input.description
          : "subagent task";
      const prompt = typeof input.prompt === "string" ? input.prompt : "";
      if (!prompt) {
        return { output: "prompt must be a non-empty string", isError: true };
      }

      const subagentType =
        typeof input.subagent_type === "string" &&
        (input.subagent_type === "explore" || input.subagent_type === "general")
          ? input.subagent_type
          : "general";

      const result = await runSubagent(
        state.config,
        state.registry,
        {
          description,
          prompt,
          subagentType,
        },
        state.stream,
        state.signal,
      );

      const usage =
        result.toolCalls > 0
          ? `\n[subagent: ${result.toolCalls} tool calls, ${result.usage.input_tokens ?? 0} in / ${result.usage.output_tokens ?? 0} out tokens]`
          : "";

      if (result.abort) {
        return {
          output: `${result.text}${usage}`,
          isError: true,
        };
      }

      return {
        output: `## Subagent: ${description}\n\n${result.text}${usage}`,
      };
    },
  };
}
