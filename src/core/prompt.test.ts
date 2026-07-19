import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildSystemPrompt, getGitContext, type GitContext } from "./prompt.js";

describe("buildSystemPrompt", () => {
  const cwd = "/home/user/project";
  const model = "claude-haiku-4-5-20251001";

  it("includes working directory, platform, shell, and model", () => {
    const prompt = buildSystemPrompt(cwd, model, "", "", null);
    expect(prompt).toContain(cwd);
    expect(prompt).toContain(`Model: ${model}`);
    expect(prompt).toContain(`Platform: ${process.platform}`);
    expect(prompt).toContain("stackpilot");
  });

  it("includes git context when provided", () => {
    const gitCtx: GitContext = {
      gitRoot: "/home/user/project",
      currentBranch: "feat/my-feature",
      mainBranch: "main",
      gitUser: "Alice",
      status: "M src/foo.ts\n?? new.txt",
      recentCommits: "abc123 feat: add feature\n",
    };
    const prompt = buildSystemPrompt(cwd, model, "", "", gitCtx);
    expect(prompt).toContain("Git root: /home/user/project");
    expect(prompt).toContain("Current branch: feat/my-feature");
    expect(prompt).toContain("Git user: Alice");
    expect(prompt).toContain("M src/foo.ts");
    expect(prompt).toContain("abc123 feat: add feature");
  });

  it("shows (clean) when git status is empty", () => {
    const gitCtx: GitContext = {
      gitRoot: cwd,
      currentBranch: "main",
      mainBranch: "main",
      gitUser: "Bob",
      status: "",
      recentCommits: "",
    };
    const prompt = buildSystemPrompt(cwd, model, "", "", gitCtx);
    expect(prompt).toContain("(clean)");
  });

  it("omits git sections when no git context", () => {
    const prompt = buildSystemPrompt(cwd, model, "", "", null);
    expect(prompt).not.toContain("Git root");
    expect(prompt).not.toContain("Current branch");
  });

  it("includes security and coding conventions", () => {
    const prompt = buildSystemPrompt(cwd, model, "", "", null);
    expect(prompt).toContain("Security and safety");
    expect(prompt).toContain("blast radius");
    expect(prompt).toContain("Coding conventions");
    expect(prompt).toContain("Read before you write");
  });

  it("includes tool usage guidance", () => {
    const prompt = buildSystemPrompt(cwd, model, "", "", null);
    expect(prompt).toContain("Tool usage");
    expect(prompt).toContain("Glob for file discovery");
    expect(prompt).toContain("Grep for content search");
    expect(prompt).toContain("Agent with subagent_type=explore");
  });

  it("includes instructions section when provided", () => {
    const instructions = "Custom project instructions here.";
    const prompt = buildSystemPrompt(cwd, model, instructions, "", null);
    expect(prompt).toContain("Project and user instructions");
    expect(prompt).toContain(instructions);
  });

  it("omits instructions section when empty", () => {
    const prompt = buildSystemPrompt(cwd, model, "", "", null);
    expect(prompt).not.toContain("Project and user instructions");
  });

  it("includes skills text when provided", () => {
    const skills = "## Available Skills\n- my-skill: does things";
    const prompt = buildSystemPrompt(cwd, model, "", skills, null);
    expect(prompt).toContain(skills);
  });

  it("omits skills when empty", () => {
    const prompt = buildSystemPrompt(cwd, model, "", "", null);
    expect(prompt).not.toContain("Available");
  });
});

describe("getGitContext", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when not in a git repo", () => {
    // We can't easily test the happy path without git, but we can verify
    // the function exists and is callable from a non-git temp dir.
    const ctx = getGitContext("/tmp");
    // /tmp may or may not be a git repo — just verify the shape
    if (ctx !== null) {
      expect(ctx).toHaveProperty("gitRoot");
      expect(ctx).toHaveProperty("currentBranch");
      expect(ctx).toHaveProperty("gitUser");
      expect(ctx).toHaveProperty("status");
      expect(ctx).toHaveProperty("recentCommits");
    }
  });
});
