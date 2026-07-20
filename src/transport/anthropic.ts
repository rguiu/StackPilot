// Anthropic Messages transport (SSE) + the provider router.
//
// The streaming core, types, and retry helpers live in stream.ts (shared with
// the Bedrock transport). This file keeps the Anthropic SSE request/parse and
// re-exports the shared surface so existing imports from "./anthropic.js"
// keep working unchanged.

import {
  ApiError,
  assembleStream,
  parseRetryAfter,
  sseData,
  withRetry,
  type MessagesRequest,
  type StreamFn,
  type StreamResult,
  type TransportConfig,
} from "./stream.js";
import { streamBedrock } from "./bedrock.js";

// Re-export the shared transport surface (back-compat: callers import these
// from "./anthropic.js").
export {
  ApiError,
  NetworkError,
  MidStreamError,
  DEFAULT_RETRY,
  isRetryable,
  parseRetryAfter,
  assembleStream,
  sseData,
} from "./stream.js";
export type {
  UsageInfo,
  StreamResult,
  RetryConfig,
  TransportConfig,
  MessagesRequest,
  StreamFn,
  Provider,
} from "./stream.js";

// POST /v1/messages with stream:true. Emits text deltas through onText as
// they arrive; resolves with the fully assembled assistant turn.
export async function streamMessage(
  cfg: TransportConfig,
  req: MessagesRequest,
  onText: (delta: string) => void,
  signal?: AbortSignal,
): Promise<StreamResult> {
  const res = await fetch(`${cfg.baseUrl}/v1/messages?beta=true`, {
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
      ...(cfg.thinkingBudgetTokens
        ? {
            thinking: {
              type: "enabled" as const,
              budget_tokens: cfg.thinkingBudgetTokens,
            },
          }
        : {}),
    }),
  });

  if (!res.ok || !res.body) {
    throw new ApiError(
      res.status,
      await res.text(),
      parseRetryAfter(res.headers.get("retry-after")),
    );
  }

  return assembleStream(sseData(res.body), onText);
}

// Pick the raw (un-retried) transport for the configured provider.
function transportFor(cfg: TransportConfig): StreamFn {
  return cfg.provider === "bedrock" ? streamBedrock : streamMessage;
}

// Build the retrying stream function for this config's provider.
export function streamWithRetry(cfg: TransportConfig): StreamFn {
  return withRetry(transportFor(cfg), cfg);
}
