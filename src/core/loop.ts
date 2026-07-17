// Agent turn orchestration. Owns the request→tool→request cycle; all
// dependencies are injected so the loop itself stays testable and free of
// direct I/O decisions.

import type { SessionStore } from "../session/store.js";
import { reduce, toApiMessages } from "./reducer.js";
import type {
  MessagesRequest,
  StreamResult,
  TransportConfig,
  UsageInfo,
} from "../transport/anthropic.js";
import { executeTool, type Registry } from "../tools/index.js";

export interface TurnIO {
  onText(delta: string): void;
  onToolStart(name: string, input: Record<string, unknown>): void;
  onToolEnd(name: string, output: string, isError: boolean): void;
  // Permission gate: true → run the tool. Read-only tools bypass this.
  permit(name: string, input: Record<string, unknown>): Promise<boolean>;
}

export interface TurnDeps {
  store: SessionStore;
  registry: Registry;
  config: TransportConfig;
  system: string;
  io: TurnIO;
  // Optional interrupt (Esc in the TUI). Aborting mid-stream discards the
  // in-flight assistant turn; the event tree stays consistent because events
  // are only appended after a request completes.
  signal?: AbortSignal;
  stream(
    cfg: TransportConfig,
    req: MessagesRequest,
    onText: (d: string) => void,
    signal?: AbortSignal,
  ): Promise<StreamResult>;
}

export interface TurnStats {
  requests: number;
  toolCalls: number;
  usage: Required<Pick<UsageInfo, "input_tokens" | "output_tokens">> & {
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}

const MAX_ITERATIONS = 40;

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

function toolUses(content: unknown[]): ToolUseBlock[] {
  return content.filter(
    (b): b is ToolUseBlock =>
      typeof b === "object" &&
      b !== null &&
      (b as { type?: string }).type === "tool_use",
  );
}

export async function runTurn(
  deps: TurnDeps,
  userText: string,
): Promise<TurnStats> {
  const { store, registry, config, system, io } = deps;
  const stats: TurnStats = {
    requests: 0,
    toolCalls: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };

  let leaf = reduce(store.all()).leafUuid;
  leaf = store.append({
    type: "user",
    parentUuid: leaf,
    message: { role: "user", content: [{ type: "text", text: userText }] },
  }).uuid!;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const reduced = reduce(store.all());
    stats.requests++;
    const result = await deps.stream(
      config,
      {
        system,
        tools: registry.schemas(),
        messages: toApiMessages(reduced.messages),
      },
      io.onText,
      deps.signal,
    );
    accumulate(stats, result.usage);

    leaf = store.append({
      type: "assistant",
      parentUuid: leaf,
      message: {
        role: "assistant",
        content: result.content,
        usage: result.usage,
      },
    }).uuid!;

    const uses = toolUses(result.content);
    if (result.stopReason !== "tool_use" || uses.length === 0) break;

    const results: unknown[] = [];
    for (const use of uses) {
      results.push(await dispatchTool(deps, use, stats));
    }
    leaf = store.append({
      type: "user",
      parentUuid: leaf,
      message: { role: "user", content: results },
    }).uuid!;
  }

  return stats;
}

async function dispatchTool(
  deps: TurnDeps,
  use: ToolUseBlock,
  stats: TurnStats,
): Promise<unknown> {
  const { registry, io } = deps;
  const input = use.input ?? {};
  const def = registry.get(use.name);
  stats.toolCalls++;

  let output: string;
  let isError = false;
  if (!def) {
    output = `unknown tool: ${use.name}`;
    isError = true;
  } else if (!def.readOnly && !(await io.permit(use.name, input))) {
    output = "user denied permission for this tool call";
    isError = true;
  } else {
    io.onToolStart(use.name, input);
    const result = await executeTool(def, input, process.cwd());
    output = result.output;
    isError = result.isError === true;
    io.onToolEnd(use.name, output, isError);
  }

  return {
    type: "tool_result",
    tool_use_id: use.id,
    content: output,
    ...(isError ? { is_error: true } : {}),
  };
}

function accumulate(stats: TurnStats, usage: UsageInfo): void {
  stats.usage.input_tokens += usage.input_tokens ?? 0;
  stats.usage.output_tokens += usage.output_tokens ?? 0;
  stats.usage.cache_read_input_tokens += usage.cache_read_input_tokens ?? 0;
  stats.usage.cache_creation_input_tokens +=
    usage.cache_creation_input_tokens ?? 0;
}
