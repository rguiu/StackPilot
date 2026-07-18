// ReadMore: expand a truncated tool_result by tool_use_id.
// The full output is stored in SessionState.pagedOutputs during paging.

import type { SessionState } from "../core/policies.js";
import { type ToolDef, type ToolResult } from "./types.js";

export function createReadMoreTool(state: SessionState): ToolDef {
  return {
    name: "ReadMore",
    description:
      "Expand a previously truncated tool result. Use the tool_use_id " +
      "from the truncated block's metadata to retrieve the full output.",
    readOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        tool_use_id: {
          type: "string",
          description: "The tool_use_id of the truncated output to expand",
        },
        offset: {
          type: "number",
          description: "1-indexed first line to return (default: start)",
        },
        limit: {
          type: "number",
          description: "Max lines to return (default: all remaining)",
        },
      },
      required: ["tool_use_id"],
    },
    execute(input): Promise<ToolResult> {
      const id = input.tool_use_id;
      if (typeof id !== "string" || id.length === 0) {
        return Promise.resolve({
          output: '"tool_use_id" must be a non-empty string',
          isError: true,
        });
      }

      const full = state.pagedOutputs.get(id);
      if (!full) {
        return Promise.resolve({
          output: `no cached output for tool_use_id ${id}. The output may not have been truncated, or the session cache may have been cleared.`,
          isError: true,
        });
      }

      const offset =
        typeof input.offset === "number" && input.offset > 0 ? input.offset : 1;
      const limit =
        typeof input.limit === "number" && input.limit > 0
          ? input.limit
          : undefined;

      const lines = full.split("\n");
      const slice = limit
        ? lines.slice(offset - 1, offset - 1 + limit)
        : lines.slice(offset - 1);
      const output = slice.join("\n");

      return Promise.resolve({
        output: `${output}\n\n[lines ${offset}-${offset + slice.length - 1} of ${lines.length}]`,
      });
    },
  };
}
