import { describe, expect, it } from "vitest";
import {
  computeCostUsd,
  formatUsd,
  normalizeModelId,
  resolveRates,
} from "./cost.js";
import type { ModelPricing } from "../config.js";

const haiku: ModelPricing = {
  inputPerMTok: 1.0,
  outputPerMTok: 5.0,
  cacheInputPerMTok: 0.1,
  cacheWritePerMTok: 1.25,
};

describe("resolveRates", () => {
  const pricing = { "claude-haiku-4-5": haiku };

  it("matches exactly", () => {
    expect(resolveRates("claude-haiku-4-5", pricing)).toBe(haiku);
  });

  it("falls back to the date-stripped id", () => {
    expect(resolveRates("claude-haiku-4-5-20251001", pricing)).toBe(haiku);
  });

  it("returns null for unknown models and null input", () => {
    expect(resolveRates("gpt-4o", pricing)).toBeNull();
    expect(resolveRates(null, pricing)).toBeNull();
  });

  it("normalizes a Bedrock inference-profile id to the bare alias", () => {
    expect(
      resolveRates("eu.anthropic.claude-haiku-4-5-20251001-v1:0", pricing),
    ).toBe(haiku);
  });
});

describe("normalizeModelId", () => {
  it.each([
    ["eu.anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5"],
    ["us.anthropic.claude-opus-4-1-v1:0", "claude-opus-4-1"],
    ["anthropic.claude-sonnet-4-5-v2:0", "claude-sonnet-4-5"],
    ["claude-haiku-4-5-20251001", "claude-haiku-4-5"],
    ["claude-haiku-4-5", "claude-haiku-4-5"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeModelId(input)).toBe(expected);
  });
});

describe("computeCostUsd", () => {
  it("bills each counter at its rate", () => {
    const cost = computeCostUsd(
      {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
      },
      haiku,
    );
    expect(cost).toBeCloseTo(1.0 + 5.0 + 0.1 + 1.25, 10);
  });

  it("falls back to the input rate for missing cache rates", () => {
    const cost = computeCostUsd(
      { cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0 },
      { inputPerMTok: 2.0, outputPerMTok: 4.0 },
    );
    expect(cost).toBeCloseTo(2.0, 10);
  });

  it("treats missing counters as zero", () => {
    expect(computeCostUsd({}, haiku)).toBe(0);
  });
});

describe("formatUsd", () => {
  it("uses 4 decimals under 10 cents, 2 above", () => {
    expect(formatUsd(0.0086)).toBe("$0.0086");
    expect(formatUsd(1.5)).toBe("$1.50");
  });
});
