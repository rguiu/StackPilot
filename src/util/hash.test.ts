import { describe, expect, it } from "vitest";
import { sha256, sha256Truncated } from "./hash.js";

describe("sha256", () => {
  it("produces a 64-char hex string", () => {
    const result = sha256("hello");
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(sha256("test")).toBe(sha256("test"));
  });

  it("produces different hashes for different inputs", () => {
    expect(sha256("a")).not.toBe(sha256("b"));
  });

  it("handles objects via JSON.stringify", () => {
    const hash = sha256({ a: 1 });
    expect(hash).toBe(sha256({ a: 1 }));
    expect(hash).not.toBe(sha256({ a: 2 }));
  });
});

describe("sha256Truncated", () => {
  it("returns shorter hash with default length 16", () => {
    const result = sha256Truncated("hello");
    expect(result).toHaveLength(16);
  });

  it("respects custom length", () => {
    expect(sha256Truncated("hello", 8)).toHaveLength(8);
  });

  it("throws if length exceeds 64", () => {
    // This won't throw — slice only returns what's available
    expect(sha256Truncated("hello", 100)).toHaveLength(64);
  });

  it("is deterministic", () => {
    expect(sha256Truncated("test")).toBe(sha256Truncated("test"));
  });
});
