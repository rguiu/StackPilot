// Streaming Anthropic Messages client. No SDK — explicit fetch + SSE parse.
// I/O only: no message-stack logic here.

export interface UsageInfo {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface StreamResult {
  content: unknown[]; // assistant content blocks (text / tool_use)
  stopReason: string | null;
  usage: UsageInfo;
  model: string | null;
}

export interface TransportConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
}

export interface MessagesRequest {
  system: unknown;
  tools: unknown[];
  messages: { role: "user" | "assistant"; content: unknown }[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Anthropic API ${status}: ${body.slice(0, 400)}`);
  }
}

interface MutableBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  partialJson?: string;
}

// POST /v1/messages with stream:true. Emits text deltas through onText as
// they arrive; resolves with the fully assembled assistant turn.
export async function streamMessage(
  cfg: TransportConfig,
  req: MessagesRequest,
  onText: (delta: string) => void,
  signal?: AbortSignal,
): Promise<StreamResult> {
  const res = await fetch(`${cfg.baseUrl}/v1/messages`, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: cfg.maxTokens,
      stream: true,
      system: req.system,
      tools: req.tools,
      messages: req.messages,
    }),
  });

  if (!res.ok || !res.body) {
    throw new ApiError(res.status, await res.text());
  }

  const blocks = new Map<number, MutableBlock>();
  let stopReason: string | null = null;
  let model: string | null = null;
  const usage: UsageInfo = {};

  for await (const data of sseData(res.body)) {
    const event = JSON.parse(data) as Record<string, unknown>;
    switch (event.type) {
      case "message_start": {
        const msg = event.message as
          { model?: string; usage?: UsageInfo } | undefined;
        model = msg?.model ?? null;
        Object.assign(usage, msg?.usage);
        break;
      }
      case "content_block_start": {
        const index = event.index as number;
        const block = event.content_block as MutableBlock;
        blocks.set(index, {
          type: block.type,
          text: block.text ?? "",
          id: block.id,
          name: block.name,
          partialJson: "",
        });
        break;
      }
      case "content_block_delta": {
        const index = event.index as number;
        const delta = event.delta as {
          type: string;
          text?: string;
          partial_json?: string;
        };
        const block = blocks.get(index);
        if (!block) break;
        if (delta.type === "text_delta" && delta.text) {
          block.text = (block.text ?? "") + delta.text;
          onText(delta.text);
        } else if (delta.type === "input_json_delta") {
          block.partialJson = (block.partialJson ?? "") + delta.partial_json;
        }
        break;
      }
      case "message_delta": {
        const delta = event.delta as { stop_reason?: string } | undefined;
        if (delta?.stop_reason) stopReason = delta.stop_reason;
        Object.assign(usage, event.usage);
        break;
      }
      case "error": {
        throw new Error(`stream error: ${JSON.stringify(event.error)}`);
      }
      default:
        break; // ping, content_block_stop, message_stop
    }
  }

  const content = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, b]) => {
      if (b.type === "tool_use") {
        return {
          type: "tool_use",
          id: b.id,
          name: b.name,
          input: b.partialJson ? JSON.parse(b.partialJson) : {},
        };
      }
      return { type: "text", text: b.text ?? "" };
    });

  return { content, stopReason, usage, model };
}

// Minimal SSE reader: yields each `data: …` payload except [DONE]-style.
async function* sseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data) yield data;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
