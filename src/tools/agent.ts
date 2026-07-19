// Agent tool: spawns isolated subagents for focused tasks.
// Subagents run in their own message context using the transport.

import { runSubagent } from "../core/subagent.js";
import type { Registry } from "./index.js";
import type {
  TransportConfig,
  MessagesRequest,
  StreamResult,
} from "../transport/anthropic.js";
import type { SessionState } from "../core/policies.js";
import { type ToolDef, type ToolResult } from "./types.js";

export interface AgentState {
  getRegistry: () => Registry;
  config: TransportConfig;
  stream: (
    cfg: TransportConfig,
    req: MessagesRequest,
    onText: (d: string) => void,
    signal?: AbortSignal,
  ) => Promise<StreamResult>;
  signal?: AbortSignal;
  cwd?: string;
  sessionState?: SessionState;
  maxToolResultChars?: number;
}

export function createAgentTool(state: AgentState): ToolDef {
  return {
    name: "Agent",
    description:
      "Spawn a subagent to handle a focused task in an isolated context. " +
      "Use for codebase exploration, research that requires multiple queries, " +
      "or tasks that would bloat the main conversation. The subagent returns " +
      "a single text result.",
    runPermitless: false,
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
        state.getRegistry(),
        {
          description,
          prompt,
          subagentType,
        },
        state.stream,
        state.signal,
        undefined,
        state.cwd ?? process.cwd(),
        state.sessionState,
        state.maxToolResultChars,
      );

      const usage =
        result.toolCalls > 0
          ? `\n[subagent: ${result.toolCalls} tool calls, ${result.usage.input_tokens} in / ${result.usage.output_tokens} out tokens]`
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
