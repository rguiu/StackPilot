import { describe, expect, it } from "vitest";
import { runSubagent } from "./subagent.js";
import { createRegistry } from "../tools/index.js";
import type {
  MessagesRequest,
  TransportConfig,
  StreamResult,
} from "../transport/anthropic.js";

const config: TransportConfig = {
  baseUrl: "http://x",
  apiKey: "k",
  model: "m",
  maxTokens: 100,
};

function textResponse(text: string): StreamResult {
  return {
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
    model: "m",
  };
}

function toolUseResponse(): StreamResult {
  return {
    content: [
      {
        type: "tool_use",
        id: "tu_1",
        name: "Read",
        input: { file_path: "foo.ts" },
      },
      { type: "text", text: "found the file" },
    ],
    stopReason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 1 },
    model: "m",
  };
}

function toolUseOnlyResponse(): StreamResult {
  return {
    content: [
      {
        type: "tool_use",
        id: "tu_1",
        name: "Read",
        input: { file_path: "foo.ts" },
      },
    ],
    stopReason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 1 },
    model: "m",
  };
}

describe("runSubagent text extraction", () => {
  it("extracts text from the final assistant message on a clean completion", async () => {
    const registry = createRegistry();
    const result = await runSubagent(
      config,
      registry,
      { description: "test", prompt: "hello" },
      async () => textResponse("all done"),
      undefined,
      undefined,
      "/fake/cwd",
    );
    expect(result.text).toBe("all done");
    expect(result.abort).toBeNull();
  });

  it("walks backwards to find text when the last message is a user tool-result", async () => {
    const registry = createRegistry();
    let call = 0;
    const result = await runSubagent(
      config,
      registry,
      { description: "test", prompt: "hello" },
      async () => {
        call++;
        // First 9 responses: tool_use with text mixed in
        if (call <= 9) return toolUseResponse();
        // 10th (last): tool_use without text
        return toolUseOnlyResponse();
      },
      undefined,
      undefined,
      "/fake/cwd",
    );
    // Even though the 10th assistant response had no text (only tool_use),
    // text from the 9th response should be found by walking backwards.
    expect(result.text).not.toBe("[subagent returned no text]");
    expect(result.text).not.toBe("");
  });

  it("returns no_text abort when no assistant message has text", async () => {
    const registry = createRegistry();
    const result = await runSubagent(
      config,
      registry,
      { description: "test", prompt: "hello" },
      async () => toolUseOnlyResponse(),
      undefined,
      undefined,
      "/fake/cwd",
    );
    expect(result.abort).toBe("no_text");
    expect(result.text).toBe("[subagent returned no text]");
  });

  it("propagates AbortError from stream", async () => {
    const registry = createRegistry();
    await expect(
      runSubagent(
        config,
        registry,
        { description: "test", prompt: "hello" },
        async () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        },
        undefined,
        undefined,
        "/fake/cwd",
      ),
    ).rejects.toThrow("aborted");
  });
});

describe("runSubagent request caching", () => {
  it("applies cache_control markers to every iteration's request", async () => {
    const registry = createRegistry();
    const captured: MessagesRequest[] = [];
    let call = 0;
    await runSubagent(
      config,
      registry,
      { description: "test", prompt: "hello" },
      async (_cfg, req) => {
        captured.push(req);
        call++;
        if (call <= 2) return toolUseResponse();
        return textResponse("all done");
      },
      undefined,
      undefined,
      "/fake/cwd",
    );
    expect(captured.length).toBeGreaterThanOrEqual(3);
    for (const req of captured) {
      const json = JSON.stringify(req);
      expect(json).toContain("cache_control");
    }
    const first = captured[0]!;
    const systemBlocks = first.system as Record<string, unknown>[];
    expect(systemBlocks[systemBlocks.length - 1]!.cache_control).toEqual({
      type: "ephemeral",
    });
  });

  it("passes subConfig.cacheTtl through to the request", async () => {
    const registry = createRegistry();
    let captured: MessagesRequest | undefined;
    await runSubagent(
      { ...config, cacheTtl: "1h" },
      registry,
      { description: "test", prompt: "hello" },
      async (_cfg, req) => {
        captured = req;
        return textResponse("done");
      },
      undefined,
      undefined,
      "/fake/cwd",
    );
    const systemBlocks = captured!.system as Record<string, unknown>[];
    expect(systemBlocks[systemBlocks.length - 1]!.cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
  });
});
