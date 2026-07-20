import { describe, expect, it } from "vitest";
import { MarkdownRenderer } from "./markdown.js";

// In the test env stdout is not a TTY, so the ansi helpers pass text through
// unstyled — assertions can match the rendered text directly.

describe("MarkdownRenderer.push", () => {
  it("emits completed lines and buffers the partial tail", () => {
    const md = new MarkdownRenderer();
    // No newline yet → nothing emitted, tail buffered.
    expect(md.push("hello ")).toBe("");
    // Newline completes the line.
    const out = md.push("world\n");
    expect(out).toContain("hello world");
  });

  it("renders a heading with an underline rule", () => {
    const md = new MarkdownRenderer();
    const out = md.push("# Title\n");
    expect(out).toContain("Title");
    // h1 adds a rule line of box-drawing chars.
    expect(out).toContain("─");
  });

  it("renders list items with a bullet", () => {
    const md = new MarkdownRenderer();
    const out = md.push("- first\n- second\n");
    expect(out).toContain("• first");
    expect(out).toContain("• second");
  });

  it("renders inline bold and code", () => {
    const md = new MarkdownRenderer();
    const out = md.push("some **bold** and `code` here\n");
    expect(out).toContain("bold");
    expect(out).toContain("code");
    // The markdown markers themselves are consumed.
    expect(out).not.toContain("**bold**");
    expect(out).not.toContain("`code`");
  });

  it("buffers a fenced code block and renders it on close", () => {
    const md = new MarkdownRenderer();
    md.push("```ts\n");
    md.push("const x = 1;\n");
    const closed = md.push("```\n");
    expect(closed).toContain("const x = 1;");
    // Code block gets a framed border.
    expect(closed).toContain("┌");
    expect(closed).toContain("└");
  });

  it("flush drains a buffered partial line", () => {
    const md = new MarkdownRenderer();
    md.push("trailing text with no newline");
    const flushed = md.flush();
    expect(flushed).toContain("trailing text with no newline");
    // Second flush is empty (buffer drained).
    expect(md.flush()).toBe("");
  });

  it("flush closes an unterminated code block", () => {
    const md = new MarkdownRenderer();
    md.push("```\n");
    md.push("unterminated\n");
    const flushed = md.flush();
    expect(flushed).toContain("unterminated");
  });

  it("reset clears buffered state between turns", () => {
    const md = new MarkdownRenderer();
    md.push("half a line");
    md.reset();
    // After reset the buffered fragment is gone.
    expect(md.flush()).toBe("");
  });

  it("handles a delta split mid-line across calls", () => {
    const md = new MarkdownRenderer();
    expect(md.push("## Head")).toBe(""); // no newline yet
    const out = md.push("ing\n");
    expect(out).toContain("Heading");
  });
});
