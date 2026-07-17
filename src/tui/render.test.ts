import { describe, expect, it } from "vitest";
import {
  formatAge,
  permissionLabel,
  statsLine,
  toolEndLine,
  toolStartLine,
  usageSummary,
} from "./render.js";
import type { TurnStats } from "../core/loop.js";

const stats = (over: Partial<TurnStats["usage"]> = {}): TurnStats => ({
  requests: 2,
  toolCalls: 3,
  usage: {
    input_tokens: 100,
    output_tokens: 50,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    ...over,
  },
  notes: [],
});

describe("toolStartLine", () => {
  it("shows the command for Bash", () => {
    expect(toolStartLine("Bash", { command: "npm test" })).toContain(
      "npm test",
    );
  });

  it("truncates long arguments", () => {
    const line = toolStartLine("Read", { file_path: "x".repeat(200) });
    expect(line).toContain("…");
    expect(line.length).toBeLessThan(200);
  });

  it("handles empty input", () => {
    expect(toolStartLine("TodoWrite", {})).toContain("TodoWrite");
  });
});

describe("toolEndLine", () => {
  it("shows first line and a line count", () => {
    const line = toolEndLine("one\ntwo\nthree", false);
    expect(line).toContain("one");
    expect(line).toContain("+2 lines");
  });

  it("marks errors", () => {
    expect(toolEndLine("boom", true)).toContain("✗");
  });
});

describe("statsLine", () => {
  it("omits cache when zero", () => {
    expect(statsLine(stats())).not.toContain("cache");
  });

  it("includes cache and hit rate when present", () => {
    const line = statsLine(stats({ cache_read_input_tokens: 500 }));
    expect(line).toContain("500r");
    expect(line).toContain("83% cached"); // 500 / (100 + 500)
  });
});

describe("usageSummary", () => {
  it("sums across turns", () => {
    const out = usageSummary([stats(), stats()]);
    expect(out).toContain("turns          2");
    expect(out).toContain("input tokens   200");
    expect(out).toContain("output tokens  100");
  });
});

describe("permissionLabel", () => {
  it("previews the command for Bash", () => {
    expect(permissionLabel("Bash", { command: "rm -rf build" })).toBe(
      "Allow Bash(rm -rf build)?",
    );
  });

  it("works without a previewable arg", () => {
    expect(permissionLabel("TodoWrite", {})).toBe("Allow TodoWrite?");
  });
});

describe("formatAge", () => {
  it.each([
    [30_000, "just now"],
    [5 * 60_000, "5m ago"],
    [3 * 3_600_000, "3h ago"],
    [49 * 3_600_000, "2d ago"],
  ])("%d ms → %s", (ms, expected) => {
    expect(formatAge(ms)).toBe(expected);
  });
});
