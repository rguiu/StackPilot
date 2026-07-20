// Bedrock transport: POST to /model/<modelId>/invoke-with-response-stream and
// decode the AWS binary event-stream framing into the shared assembler.
//
// Two deployments share this code:
//   - Proxy mode: baseUrl points at a local gateway that performs SigV4 for
//     us (the StackPilot dev environment). No AWS creds needed here.
//   - Native mode: baseUrl is bedrock-runtime.<region>.amazonaws.com and the
//     request must be SigV4-signed (see signRequest). Selected by config.
//
// The request body differs from the Anthropic API: `anthropic_version` is
// "bedrock-2023-05-31", there is NO top-level `model` field (it's in the URL),
// and cache_control / tools / system all pass through unchanged.

import { bedrockEvents } from "./eventstream.js";
import {
  ApiError,
  assembleStream,
  parseRetryAfter,
  type MessagesRequest,
  type StreamResult,
  type TransportConfig,
} from "./stream.js";
import { signBedrockRequest } from "./sigv4.js";

export function bedrockBody(
  cfg: TransportConfig,
  req: MessagesRequest,
): Record<string, unknown> {
  return {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: cfg.maxTokens,
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
  };
}

export async function streamBedrock(
  cfg: TransportConfig,
  req: MessagesRequest,
  onText: (delta: string) => void,
  signal?: AbortSignal,
): Promise<StreamResult> {
  const url = `${cfg.baseUrl}/model/${encodeURIComponent(cfg.model)}/invoke-with-response-stream`;
  const bodyText = JSON.stringify(bedrockBody(cfg, req));

  // Proxy mode: the gateway signs. Native mode: sign here with AWS creds.
  const headers = await signBedrockRequest(cfg, url, bodyText);

  const res = await fetch(url, {
    method: "POST",
    signal,
    headers,
    body: bodyText,
  });

  if (!res.ok || !res.body) {
    throw new ApiError(
      res.status,
      await res.text(),
      parseRetryAfter(res.headers.get("retry-after")),
    );
  }

  const result = await assembleStream(bedrockEvents(res.body), onText);
  // Bedrock's message_start omits the model id; fill it from config so the
  // cost meter and cache ledger see a stable model name.
  return { ...result, model: result.model ?? cfg.model };
}
