# Known Issues

Found during pre-release code review. Not blockers — documented for awareness.

## TodoWrite marked `readOnly: true` despite mutating state

`src/tools/todo.ts:24` marks the tool as `readOnly: true`. This bypasses
permission prompts (correct — TodoWrite has no filesystem side-effects),
but the name is misleading: the tool mutates in-memory session state
via `state.todos = next`. The `readOnly` flag is used as "don't prompt
the user" rather than "no mutations." Functionally correct, semantically
confusing. Consider renaming to `bypassPermission` or similar.

## Content blocks use `unknown` with pervasive casts

API message content blocks are typed as `unknown` throughout the codebase.
Casts like `(b as { type?: string }).type` appear in `reducer.ts`,
`loop.ts`, `subagent.ts`, `cache.ts`, `compact.ts`, `policies.ts`.
A discriminated union type would make the code safer:

```typescript
type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };
```

## No test coverage for key modules

| Module                   | What's untested                                         |
| ------------------------ | ------------------------------------------------------- |
| `core/prompt.ts`         | System prompt building, git context extraction          |
| `core/policies.ts`       | Paging, dedup, eviction (pure functions — easy to test) |
| `core/instructions.ts`   | CLAUDE.md hierarchical loading                          |
| `core/hooks.ts`          | Hook runner with timeout                                |
| `core/subagent.ts`       | Subagent loop                                           |
| `transport/anthropic.ts` | SSE parsing, stream message, retry logic                |
| `tools/shell.ts`         | Bash execution, timeout handling                        |
| `tools/patch.ts`         | Diff application                                        |
| `tools/memory.ts`        | Session metadata extraction                             |
| `tools/skill.ts`         | Skill discovery and loading                             |
| `tools/agent.ts`         | Agent tool                                              |
| `tools/readmore.ts`      | ReadMore paging                                         |
| `tui/markdown.ts`        | Markdown stream renderer                                |
| `tui/app.ts`             | TUI shell                                               |

## Subagent doesn't apply context policies

`src/core/subagent.ts` builds its message array from scratch and does not
run `pageToolResults`, `deduplicateReads`, or `evictOldResults`. For the
subagent this may be fine since its context is smaller (10 iteration max),
but long tool outputs in subagent turns accumulate without paging.

## `process.cwd()` global in loop and subagent

`src/core/loop.ts` and `src/core/subagent.ts` call `process.cwd()` directly
instead of receiving `cwd` through `TurnDeps`. This makes the loop
non-portable for testing. The composition root already has `cwd` available.

## Code duplication

- `toolUses` filter function: duplicated in `loop.ts` and `subagent.ts`
- `accumulate` for usage stats: identical in `loop.ts` and `subagent.ts`
- `absPath` function: duplicated in `fs.ts` and `patch.ts`
- `!` shell command handler: duplicated in `app.ts` and `main.ts`
- `sha` function: duplicated in `cache.ts` (SHA-256) and `policies.ts` (SHA-256 truncated to 16 chars)

## AgentState circular reference

`src/tools/agent.ts` uses a lazy-initialized circular reference:
`agentState.registry = registry` is assigned after `createRegistry()` returns.
If `createAgentTool`'s `execute` is called before the assignment, `state.registry`
is `undefined`. Works by ordering in `main.ts` but fragile.

## No graceful TUI shutdown on SIGINT during a turn

In `src/tui/app.ts`, Ctrl+C during a turn triggers `main.ts`'s
`process.once("SIGINT")` handler which fires `fireSessionEnd()` and exits.
The readline interface may be left in raw mode — `rl.close()` on the TUI
cleanup path may never execute.
