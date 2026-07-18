# stackpilot

A lean coding agent with full control of the message stack. Behavioral clone of
Claude Code's core, rebuilt smaller — not by guessing, but by recording real
sessions through the
[ai-agent-profiler](https://github.com/rguiu/ai-agent-profiler) proxy and
extracting the wire protocol.

**Why?** Claude Code is the best coding agent, but it's a black box — you can't
see what's in the message stack, can't tune caching, can't experiment with
context policies. StackPilot gives you the same behavioral core with every layer
exposed and controllable. Same loop, matching tool schemas where they overlap,
and client-side cache awareness that Claude Code lacks (fingerprint diffing
predicts and verifies cache behavior before the server reports it).

**Built from traces, not docs.** Every feature was verified against recorded
Claude Code sessions: system prompt, tool schemas, cache breakpoint placement,
compaction protocol, transcript tree structure. See
[docs/protocol/](docs/protocol/) for the raw findings and
[fixtures/traces/](fixtures/traces/) for the golden traces.

**Early but functional.** Phases P0 through P5 are complete — streaming loop,
14 tools (including subagents and skills), prompt caching with client fingerprint
ledger, auto-compaction, dollar cost meter, hooks, session memory, and a TUI
with markdown rendering. P3b context policies (tool-result paging, read
deduplication, stack eviction) give stack control that Claude Code doesn't
expose. See [docs/PLAN.md](docs/PLAN.md) for the roadmap and
[OPTIMIZATION_IDEAS.md](docs/OPTIMIZATION_IDEAS.md) for what's next.

```bash
npx tsx src/cli/main.ts
```

## Quick start

```bash
# Set your API key (same as Claude Code uses)
export ANTHROPIC_API_KEY=sk-ant-...

# Interactive REPL
npx tsx src/cli/main.ts

# One-shot (headless)
npx tsx src/cli/main.ts -p "What does src/core/loop.ts do?"

# Resume last session
npx tsx src/cli/main.ts -c

# Skip permission prompts
npx tsx src/cli/main.ts --yolo

# JSON output (for scripting)
npx tsx src/cli/main.ts -p "explain cache.ts" --json
```

## Features

### Core loop

Streaming REPL with the Anthropic Messages API. Tools execute in the current
working directory. Append-only JSONL session tree — sessions survive crashes,
support rewind/resume, and replay deterministically.

### TUI

Inline terminal UI with readline input, Esc interrupt, spinner, permission
prompts with session allowlists and deny-with-feedback, arrow-key session picker,
markdown rendering, diff colorization, and `!` prefix for direct shell commands.

### Tools (14)

| Tool          | Description                                                              |
| ------------- | ------------------------------------------------------------------------ |
| Read          | Line-numbered file reading with offset/limit                             |
| Write         | File creation with auto mkdir                                            |
| Edit          | Exact-string replacement with `replace_all` support                      |
| Patch         | Unified diff application (multi-hunk, context-verified)                  |
| Bash          | Shell command execution (120s default timeout)                           |
| Grep          | ripgrep-backed search: `-i`, `-A`/`-B`/`-C`, `head_limit`, `output_mode` |
| Glob          | File discovery by pattern (own walk, no deps)                            |
| TodoWrite     | Session-scoped task list                                                 |
| Agent         | Subagent spawning with isolated context (explore/general types)          |
| Skill         | Project/user skill loading from `.stackpilot/skills/<name>/SKILL.md`     |
| SearchHistory | FTS over recorded sessions via the aap proxy                             |
| SearchMemory  | SQLite FTS over session metadata (`~/.stackpilot/memory/index.db`)       |
| SearchFiles   | File-touch search across past sessions                                   |
| ReadMore      | Expand truncated tool results (offset/limit paging)                      |

### Caching & cost

Client-side cache fingerprint ledger predicts hits before API calls and
verifies them after. Dollar cost meter with configurable pricing tables
(cross-validated against the aap proxy). 3 of 4 Anthropic cache breakpoints
used — static rules, dynamic instructions, moving messages.

### Context policies

- **Tool-result paging:** truncates long outputs in the stack, stores full
  content in memory, expandable via ReadMore
- **Read deduplication:** hash-based detection of unchanged file reads
- **Stack eviction:** drops old tool_results from the message stack

### Instructions & skills

- **CLAUDE.md loading:** walks from `cwd` up to git root, loads
  `.stackpilot/CLAUDE.md` (preferred) or `CLAUDE.md` at each level, plus
  `~/.stackpilot/CLAUDE.md`
- **Skills:** project + user skill directories, YAML frontmatter SKILL.md
  files, listed in the system prompt
- **Git context:** branch, status, and recent commits injected into the
  system prompt at session start

### Hooks

Shell commands at lifecycle points (pre_tool, post_tool, session_start,
session_end). JSON context on stdin, env vars, 5s timeout, fail-open.
stdout fed back to the model as a system-reminder.

### Session memory

SQLite index at `~/.stackpilot/memory/index.db`. Extracts session metadata
on close: files touched, errors, commands, first prompt. Searchable across
sessions via SearchMemory and SearchFiles tools.

### Config

TOML config at `~/.stackpilot/config.toml` (or `$STACKPILOT_CONFIG`):
model, pricing, tools, auto-compact threshold, retries, hooks, thinking budget,
cheap model for compaction, max tool result chars.

### Cost routing

Optional cheap model for compaction/summarization (`cheapModel` in config).
Thinking budget pass-through for Sonnet/Opus.

## Slash commands

| Command          | Action                                  |
| ---------------- | --------------------------------------- |
| `/help`          | Show help                               |
| `/todos`         | Show task list                          |
| `/usage`         | Show turn stats                         |
| `/compact`       | Manual compaction                       |
| `/config`        | Configure tools, auto-compact threshold |
| `/exit`, `/quit` | Exit                                    |

## Architecture

```
src/
├── cli/main.ts          Entry point (REPL, -p, -c, --yolo, --json)
├── config.ts            Env + TOML config resolution
├── core/
│   ├── loop.ts          Turn orchestration (request→tool→request)
│   ├── prompt.ts        System prompt builder + git context
│   ├── instructions.ts  CLAUDE.md hierarchical loader
│   ├── reducer.ts       Pure event-tree → API messages
│   ├── cache.ts         Cache_control + client fingerprint ledger
│   ├── compact.ts       Auto/manual compaction
│   ├── cost.ts          Dollar cost computation
│   ├── hooks.ts         Hook runner (pre/post tool, session)
│   ├── policies.ts      Context policies (paging, dedup, eviction)
│   └── subagent.ts      Isolated subagent turn loop
├── session/
│   ├── events.ts        SessionEvent types + validation
│   └── store.ts         JSONL append-only SessionStore
├── tools/
│   ├── fs.ts            Read, Write, Edit
│   ├── patch.ts         Patch (unified diff)
│   ├── shell.ts         Bash
│   ├── search.ts        Grep, Glob
│   ├── todo.ts          TodoWrite
│   ├── history.ts       SearchHistory
│   ├── memory.ts        SearchMemory, SearchFiles
│   ├── skill.ts         Skill
│   ├── agent.ts         Agent (subagent)
│   ├── readmore.ts      ReadMore
│   ├── index.ts         Registry + dispatch
│   └── types.ts         ToolDef contract
├── transport/
│   └── anthropic.ts     Streaming Messages API client
└── tui/
    ├── app.ts           TUI shell
    ├── screen.ts        Screen layout
    ├── markdown.ts      Markdown stream renderer
    ├── render.ts        Pure formatters (stats, diffs, prompts)
    └── ansi.ts          Zero-dep ANSI styling
```

## Development

```bash
npm install
npm run typecheck       # tsc --noEmit
npm run test            # vitest run (90 tests)
npm run lint            # eslint
npm run format:check    # prettier --check
```

Requires Node >= 20. ESM, strict mode. Runtime deps: `@clack/prompts`, `smol-toml`, `better-sqlite3`.

## Docs

- [PLAN.md](docs/PLAN.md) — roadmap, decisions, phase breakdown
- [IMPLEMENTATION.md](docs/IMPLEMENTATION.md) — architecture reference
- [CHANGELOG.md](docs/CHANGELOG.md) — chronological feature log
- [OPTIMIZATION_IDEAS.md](docs/OPTIMIZATION_IDEAS.md) — cache/tool/provider ideas
- [docs/protocol/](docs/protocol/) — Claude Code wire behavior analysis
