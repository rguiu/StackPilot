# Transcript model — disk ↔ memory ↔ wire

Observed from `fixtures/transcripts/rewind-session.jsonl` (interactive session
with one rewind + one `-c` resume; Claude Code 2.1.212).

## Storage layout

- One JSONL file per session: `~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl`
- `<cwd-slug>` = absolute cwd with every `/` and `.` replaced by `-`
- `claude -c` / `--resume` **appends to the same file** (same session uuid)

## Event tree, not a log

Every line is an event with `uuid` + `parentUuid`. The file is append-only;
edits never delete. **Rewind creates a branch**: the replacement user message's
`parentUuid` points at an _earlier_ node, abandoning the old continuation.

Measured after one rewind:

| metric             | value |
| ------------------ | ----- |
| total events       | 51    |
| active-path events | 25    |
| abandoned events   | 6     |
| leaves             | 2     |
| branch points      | 2     |

The **in-memory conversation = walk from the newest leaf back to root**,
reversed. Reading top-to-bottom would include dead branches — resume must do
the leaf walk. (This matches aap's `claude-transcript.ts` reconstruction.)

## Event type census (this session)

| type                  | n   | API-visible?                       |
| --------------------- | --- | ---------------------------------- |
| assistant             | 15  | yes — carries `message`, `usage`   |
| user                  | 9   | yes — prompts and tool_results     |
| last-prompt           | 5   | no — UI state                      |
| attachment            | 4   | no                                 |
| queue-operation       | 4   | no                                 |
| permission-mode       | 3   | no                                 |
| file-history-snapshot | 3   | no — checkpoint for "Restore code" |
| system                | 3   | no                                 |
| mode                  | 2   | no                                 |
| ai-title              | 2   | no — result of the `title` request |
| file-history-delta    | 1   | no — checkpoint delta              |

Only `user`/`assistant` events are ever sent to the model. Everything else is
local UI/metadata (~50% of events in this session).

## Rewind menu semantics (observed)

- **Restore conversation** — new branch in the tree; files untouched
- **Restore code** — replay `file-history-snapshot`/`file-history-delta`
  checkpoints; tree untouched
- **Restore code and conversation** — both

## Wire vs disk token economics

Active path here is tiny (~1.6k estimated visible tokens, 3 tool results
~207 tokens) yet assistant usage reports **305k cache-read / 196k
cache-write tokens** across the session — the system prompt + 29 tool schemas
dominate every request. Conversation content is a rounding error; **prefix
stability is the whole game.**

## Implications for stackpilot

1. Event-sourced JSONL with `parentUuid` is the right disk model — keep it.
   Rewind = append with older parent; resume = newest-leaf walk. Cheap, crash
   safe, replayable.
2. Skip `file-history-*` checkpoints in v1 (git worktrees cover it) but keep
   the event types reserved so transcripts stay Claude-comparable.
3. Persist only `user`/`assistant` + a minimal `meta` event; Claude's other 9
   event types are UI state we don't need.
4. The reducer (`events → messages[]`) must be pure and tested against this
   fixture — same numbers (25 active, 6 abandoned, 2 leaves) or bust.
