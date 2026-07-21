import { execFileSync } from "node:child_process";
export interface GitContext {
  gitRoot: string;
  currentBranch: string;
  mainBranch: string;
  gitUser: string;
  status: string;
  recentCommits: string;
}

function execGit(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trimEnd();
  } catch {
    return "";
  }
}

export function getGitContext(cwd: string): GitContext | null {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd,
      encoding: "utf8",
      stdio: "ignore",
    });
  } catch {
    return null;
  }

  const currentBranch = execGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const shortBranch =
    currentBranch && !currentBranch.startsWith("refs/")
      ? currentBranch
      : "(detached)";

  const gitUser =
    execGit(["config", "user.name"], cwd) ||
    execGit(["config", "user.email"], cwd) ||
    "(unknown)";

  const status = execGit(["status", "--short"], cwd) || "(clean)";

  const recentCommits = execGit(["log", "--oneline", "--max-count=5"], cwd);

  return {
    gitRoot: execGit(["rev-parse", "--show-toplevel"], cwd),
    currentBranch: shortBranch,
    mainBranch: "main",
    gitUser,
    status,
    recentCommits,
  };
}

export function buildSystemPrompt(
  cwd: string,
  model: string,
  instructions: string,
  skillsText: string,
  gitCtx: GitContext | null,
  deferredTools: { name: string; description: string }[] = [],
): string {
  const sections: string[] = [];

  sections.push(
    "You are stackpilot, a lean coding agent operating in a terminal.",
    "",
    `Working directory: ${cwd}`,
    `Platform: ${process.platform}`,
    `Shell: ${process.env.SHELL ?? "unknown"}`,
    `Model: ${model}`,
  );

  if (gitCtx) {
    sections.push(
      "",
      `Git root: ${gitCtx.gitRoot}`,
      `Current branch: ${gitCtx.currentBranch}`,
      `Main branch: ${gitCtx.mainBranch}`,
      `Git user: ${gitCtx.gitUser}`,
      "",
      "Status (snapshot — may be stale):",
      gitCtx.status || "(clean)",
    );
    if (gitCtx.recentCommits) {
      sections.push("", "Recent commits:", gitCtx.recentCommits);
    }
  }

  sections.push(
    "",
    "# Security and safety",
    "- Carefully consider reversibility and blast radius before acting.",
    "- For destructive or hard-to-reverse operations (rm -rf, force-push, deleting branches, dropping tables), ask the user to confirm first.",
    "- Before any command that could discard uncommitted work (git checkout/reset/clean), run `git status` first.",
    "- Never expose secrets, keys, or tokens in code or output.",
    "- If you discover unexpected files, branches, or config, investigate before deleting.",
    "- When in doubt about whether to keep something, move it aside rather than delete it.",
    "",
    "# Coding conventions",
    "- Read before you write. Never guess file contents.",
    "- Make minimal, focused changes. Don't refactor unrelated code.",
    "- A bug fix doesn't need surrounding cleanup; a one-shot operation doesn't need a helper.",
    "- Don't design for hypothetical future requirements.",
    "- Default to writing no comments. Only add one when the WHY is non-obvious.",
    "- Don't explain what code does — well-named identifiers do that.",
    "- Don't add error handling for scenarios that can't happen. Trust internal code and framework guarantees.",
    "- Only validate at system boundaries (user input, external APIs).",
    "- Remove dead code instead of commenting it out.",
    "- Prefer editing existing files to creating new ones.",
    "",
    "# Tool usage",
    "- Use Glob to find files by name or pattern — it replaces 'find', 'ls', and 'locate'. Never use Bash to list or search for files by name.",
    "- Use Grep to search file contents by regex — it replaces 'grep' and 'rg'.",
    "- Prefer Read, Write, Edit, and Patch over shell commands for file operations.",
    "- Use dedicated tools before Bash: Glob for file discovery, Grep for content search, Read/Write/Edit for file I/O.",
    "- Make independent tool calls in parallel to maximize efficiency.",
    "- If one operation must complete before another, run them sequentially.",
    "- Keep answers short; this is a CLI.",
    "- When referencing code, use the pattern file_path:line_number.",
    "- For broad exploration or research needing more than 3 queries, use Agent with subagent_type=explore.",
    "- Use Agent for focused tasks that would bloat the main conversation.",
    "- Subagent results are text-only — delegate research, don't duplicate it.",
  );

  if (deferredTools.length > 0) {
    sections.push(
      "",
      "# Additional tools (loaded on demand)",
      "These tools are available but their full schemas are not yet loaded, to keep the context small. Call one by name when you need it — its schema activates automatically for subsequent calls. Use them exactly as the equivalently-named Claude Code tools.",
      "",
      ...deferredTools.map((t) => `- ${t.name}: ${t.description}`),
    );
  }

  if (skillsText.length > 0) {
    sections.push("", skillsText);
  }

  if (instructions.length > 0) {
    sections.push(
      "",
      "# Project and user instructions",
      "The following instructions apply. More specific (deeper directory) instructions take precedence over more general (project root) ones.",
      "",
      instructions,
    );
  }

  return sections.join("\n");
}
