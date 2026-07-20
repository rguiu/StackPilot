import { describe, expect, it } from "vitest";
import {
  ApiError,
  NetworkError,
  MidStreamError,
  isRetryable,
  parseRetryAfter,
  DEFAULT_RETRY,
} from "./anthropic.js";

describe("ApiError", () => {
  it("includes status and body in the message", () => {
    const e = new ApiError(429, "rate limited");
    expect(e.status).toBe(429);
    expect(e.message).toContain("429");
    expect(e.message).toContain("rate limited");
  });

  it("truncates long bodies", () => {
    const long = "x".repeat(1000);
    const e = new ApiError(500, long);
    expect(e.message.length).toBeLessThan(500);
  });
});

describe("NetworkError", () => {
  it("wraps an Error", () => {
    const cause = new Error("connection refused");
    const e = new NetworkError(cause);
    expect(e.message).toContain("connection refused");
  });

  it("wraps a string cause", () => {
    const e = new NetworkError("timeout");
    expect(e.message).toContain("timeout");
  });
});

describe("isRetryable", () => {
  it("retries on 429", () => {
    expect(isRetryable(new ApiError(429, "rate limited"))).toBe(true);
  });

  it("retries on 500+", () => {
    expect(isRetryable(new ApiError(500, "server error"))).toBe(true);
    expect(isRetryable(new ApiError(503, "unavailable"))).toBe(true);
  });

  it("does not retry on 400", () => {
    expect(isRetryable(new ApiError(400, "bad request"))).toBe(false);
  });

  it("does not retry on 401", () => {
    expect(isRetryable(new ApiError(401, "unauthorized"))).toBe(false);
  });

  it("retries on network errors", () => {
    expect(isRetryable(new NetworkError("connection refused"))).toBe(true);
  });

  it("does not retry on AbortError", () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    expect(isRetryable(e)).toBe(false);
  });

  it("does not retry a MidStreamError (would duplicate streamed output)", () => {
    expect(isRetryable(new MidStreamError(new Error("boom")))).toBe(false);
  });
});

describe("parseRetryAfter", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfter("2")).toBe(2000);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("returns undefined for missing or garbage", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("not-a-number")).toBeUndefined();
  });

  it("parses an HTTP date in the future", () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(5000);
  });
});

describe("MidStreamError", () => {
  it("wraps the cause and names itself", () => {
    const e = new MidStreamError(new Error("connection reset"));
    expect(e.name).toBe("MidStreamError");
    expect(e.message).toContain("connection reset");
  });
});

describe("ApiError retryAfter", () => {
  it("carries a parsed retryAfterMs", () => {
    const e = new ApiError(429, "slow down", 3000);
    expect(e.retryAfterMs).toBe(3000);
  });
});

describe("DEFAULT_RETRY", () => {
  it("has sensible defaults", () => {
    expect(DEFAULT_RETRY.maxRetries).toBeGreaterThan(0);
    expect(DEFAULT_RETRY.baseDelayMs).toBeGreaterThan(0);
    expect(DEFAULT_RETRY.maxDelayMs).toBeGreaterThan(DEFAULT_RETRY.baseDelayMs);
  });
});

describe("streamWithRetry", () => {
  it("returns the result on first success", async () => {
    const result = {
      content: [{ type: "text" as const, text: "hello" }],
      stopReason: "end_turn" as const,
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "test",
    };
    const got = await (async () => result)();
    expect(got.content[0]).toEqual({ type: "text", text: "hello" });
    expect(got.content[0]).toEqual({ type: "text", text: "hello" });
  });

  it("propagates non-retryable errors immediately", async () => {
    let attempts = 0;
    const bogusFn = async (): Promise<never> => {
      attempts++;
      throw new ApiError(400, "bad request");
    };

    await expect(bogusFn()).rejects.toThrow(ApiError);
    expect(attempts).toBe(1);
  });
});
