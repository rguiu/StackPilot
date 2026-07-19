import { describe, expect, it } from "vitest";
import {
  requireString,
  optionalString,
  truncate,
  ToolInputError,
} from "./types.js";

describe("requireString", () => {
  it("returns the value when a non-empty string", () => {
    expect(requireString({ key: "value" }, "key")).toBe("value");
  });

  it("throws on missing key", () => {
    expect(() => requireString({}, "key")).toThrow(ToolInputError);
    expect(() => requireString({}, "key")).toThrow(
      '"key" must be a non-empty string',
    );
  });

  it("throws on empty string", () => {
    expect(() => requireString({ key: "" }, "key")).toThrow(ToolInputError);
  });

  it("throws on wrong type", () => {
    expect(() => requireString({ key: 42 }, "key")).toThrow(ToolInputError);
    expect(() => requireString({ key: true }, "key")).toThrow(ToolInputError);
  });
});

describe("optionalString", () => {
  it("returns the value when a string", () => {
    expect(optionalString({ key: "hello" }, "key")).toBe("hello");
  });

  it("returns undefined for missing key", () => {
    expect(optionalString({}, "key")).toBeUndefined();
  });

  it("throws on wrong type when present", () => {
    expect(() => optionalString({ key: 42 }, "key")).toThrow(ToolInputError);
    expect(() => optionalString({ key: 42 }, "key")).toThrow(
      '"key" must be a string',
    );
  });
});

describe("truncate", () => {
  it("returns text unchanged when below max", () => {
    expect(truncate("short", 100)).toBe("short");
  });

  it("returns text unchanged when exactly at max", () => {
    expect(truncate("abc", 3)).toBe("abc");
  });

  it("truncates and appends ellipsis footer", () => {
    const result = truncate("1234567890", 5);
    expect(result).toContain("12345");
    expect(result).toContain("[truncated 5 of 10 chars]");
    expect(result).toHaveLength(5 + "\n… [truncated 5 of 10 chars]".length);
  });
});
