# stackpilot — Implementation Reference

Accurate as of P2b (`cost`, `compact`, `/config` commits). Companion docs:
[PLAN.md](PLAN.md) (roadmap, feature verdicts),
[CHANGELOG.md](CHANGELOG.md) (chronological record with evidence), and
[protocol/](protocol/) (recorded Claude Code wire behavior this design is
based on).

---

## 1. Design principles

1. **Record-informed cloning.** Every structural decision mirrors observed
   Claude Code behavior (captured with [ai-agent-profiler](https://github.com/anomalyco/ai-agent-profiler)),
   not guesses: the JSONL event tree, tool schema shapes, cache breakpoint
   placement, request kinds.
2. **Prefix stability is the whole game.** A recorded session showed ~1.6k
   tokens of visible conversation generate 305k cache-read + 196k
   cache-write tokens — the static prefix dominates cost. Everything that
   touches the message stack is designed append-only.
3. **Pure core, thin I/O shells.** Tree logic, formatters, cache math are
   pure functions with unit tests. I/O (terminal, disk, network) lives in
   replaceable shells that stay as small as possible.
4. **Fail fast at boundaries, tolerate at reads.** Writes validate hard
   (`assertWritable`); reads of session files skip malformed lines (a
   truncated final line is normal while a session is live).
5. **Zero-framework bias.** Node ≥ 20, ESM, strict TS. Runtime
   dependencies: `@clack/prompts` (menus) — that's it. No SDK, no React.

## 2. Repository layout

```
stackpilot/
  docs/
    PLAN.md               roadmap, feature table, phase status
    IMPLEMENTATION.md     this file
    protocol/             extracted Claude Code wire behavior (P0 output)
      system-prompt.md    3-block system prompt, cache_control markers
      tools.json          29 tool schemas as Claude Code 2.1.212 sends them
      cache-breakpoints.md  observed cache_control placement per request
      transcript-model.md disk↔memory↔wire mapping, tree numbers
      compact-session/    same extraction for a /compact session
  fixtures/
    traces/               golden aap NDJSON traces (5 scenarios, redacted)
    transcripts/          rewind-session.jsonl — reducer ground truth
  scripts/
    extract-protocol.mjs  trace → protocol docs extractor
  src/
    config.ts             env → TransportConfig resolution
    session/              events + JSONL persistence
    core/                 reducer, loop, prompt, cache (pure logic)
    transport/            Anthropic streaming client
    tools/                the 7 tools + registry
    tui/                  ANSI, pure renderers, interactive app
    cli/                  entry point, arg parsing, headless/plain modes
```

## 3. Session persistence (`src/session/`)

### 3.1 File format

One JSONL file per session:

```
~/.stackpilot/projects/<cwd-slug>/<session-uuid>.jsonl
```

- `cwd-slug` = absolute cwd with `/` and `.` replaced by `-`
  (`projectSlug`, identical to Claude Code's scheme).
- One JSON event per line, append-only. Nothing is ever rewritten.

Event shape (`SessionEvent`):

```jsonc
{
  "type": "user" | "assistant", // extensible; only these are API-visible
  "uuid": "…", // required for chained events
  "parentUuid": "…" | null, // null = root; forms the tree
  "timestamp": "ISO-8601",
  "message": {
    "role": "user" | "assistant",
    "content": "…blocks or string…",
    "usage": {} // assistant only: input/output/cache_read/cache_creation
  }
}
```

This is deliberately a compatible subset of Claude Code's transcript format:
the same reducer replays both (`fixtures/transcripts/rewind-session.jsonl`
is a real Claude Code file used as a test fixture).

### 3.2 `events.ts`

- `assertWritable(event)` — fail-fast gate before persistence: `uuid`
  required, `parentUuid` explicitly set (`null` for root), user/assistant
  events must carry a `message`. Throws `InvalidEventError`.
- `parseEventLines(raw)` — tolerant reader; malformed lines skipped, never
  fatal.

### 3.3 `store.ts` — `SessionStore`

All session disk I/O lives here; no tree logic.

| API                                    | Behavior                                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SessionStore.create(cwd, home?)`      | new uuid, mkdir -p, empty event list                                                                                                                               |
| `SessionStore.open(path)`              | parse existing file into memory                                                                                                                                    |
| `append({type, parentUuid, message?})` | the **only mutation**: assigns uuid + timestamp, validates, `appendFileSync` one line, updates memory. `parentUuid` is a required explicit argument — no defaults. |
| `SessionStore.newestFor(cwd)`          | newest session path or null                                                                                                                                        |
| `SessionStore.summariesFor(cwd)`       | sessions newest-first: `{path, id, mtimeMs, preview}`; preview = `firstUserText` (string or block content; skips tool_result-only user events)                     |

## 4. Core (`src/core/`) — pure logic

### 4.1 `reducer.ts` — the event tree

Semantics ported from aap's `claude-transcript.ts`, verified against the
recorded fixture (§10):

- **Chained event** = has a `uuid`; uuid-less metadata is ignored for
  pathing.
- **Active path** = walk from the newest chained event _in file order_ back
  through `parentUuid` to root, then reverse. (Claude Code appends new
  events physically last even after a rewind, so "last uuid line" is the
  active leaf.)
- **Rewind** = appending an event whose `parentUuid` points at an earlier
  node; the old continuation remains as an abandoned branch.
- Stats: `leafCount` = chained events nobody references as parent;
  `branchPoints` = parents with >1 child; `abandonedEvents` =
  chained − activePath.
- `reduce(events)` → `{stats, activePath, leafUuid, messages}`;
  `leafUuid` = parent for the next append.
- `toApiMessages` strips local `usage` before sending.

**Tested guarantee:** replaying the real Claude Code rewind transcript
yields exactly 51 total / 25 active / 6 abandoned / 2 leaves /
2 branch points / 19 API messages, and follows the rewound branch.

### 4.2 `loop.ts` — turn orchestration

`runTurn(deps, userText)`:

```
append user event
loop (max 40 iterations):
  messages ← reduce(store.all())          // re-derived every iteration
  result   ← stream(config, request, onText, signal)
  append assistant event (content + usage)
  if stop_reason ≠ "tool_use" → done
  per tool_use block:
    unknown tool      → error result
    mutating + denied → "user denied permission for this tool call"
    else              → execute, wrap output
  append user event with all tool_result blocks
```

All dependencies injected (`TurnDeps`: store, registry, config, system, io,
stream, signal) — no direct I/O; tested with fake streams.

**Invariant — tool_use/tool_result pairing (tested):** once an assistant
event containing `tool_use` blocks is persisted, a `tool_result` for every
id MUST follow, or every later request on that path is rejected by the
API. If the tool phase throws (Esc, crash), the catch backfills synthetic
results (`[interrupted by user]`, `is_error: true`), persists them, and
rethrows. Verified live: cancelling a permission menu mid-turn leaves the
session resumable.

**Interrupts:** `deps.signal` goes to the transport. Mid-stream abort
persists nothing for the in-flight request — consistent by construction.
Tool-phase abort hits the backfill invariant.

`TurnStats`: requests, toolCalls, four usage counters accumulated across
the request loop.

### 4.3 `prompt.ts`

`buildSystemPrompt(cwd)` — byte-stable within a session by design rule:
nothing time- or turn-dependent allowed (§1.2). Identity, cwd, 5 rules.

### 4.4 `cache.ts` — client-side cache awareness (P2a, in progress)

The Anthropic cache lives server-side; locally we own three things:

1. **Markers.** `applyCacheControl(system, tools, messages)` adds 2 of the
   4 allowed breakpoints: _static_ (single system block — covers
   tools + system, as the server prefix is ordered tools → system →
   messages) and _moving_ (last content block of the last message — each
   turn extends the cached conversation; server prefix-matches recent
   breakpoints so pure appends hit). String content is converted to a text
   block to carry the marker.
2. **Fingerprints.** `prefixFingerprint(req)`: sha256 per prefix component
   (static part; each message) over marker-stripped JSON
   (`stripCacheControl` — the server excludes `cache_control` from cache
   keys, so equality checks must too). `diffFingerprints(prev, next)` →
   `{divergedAt, staticChanged, invalidatedApproxTokens}`; `null` = pure
   append (expected hit); index k = everything from message k re-writes at
   1.25×. This is the primitive P3 mutation policies will consult before
   editing history ("is this mutation worth the regen?").
3. **Ledger.** `CacheLedger.beforeRequest` stores fingerprint + prediction;
   `afterResponse(usage)` reconciles with the server's
   `cache_read/creation` counters → verdict: `first | hit |
predicted-regen | unexpected-regen` (last = stable prefix but server
   wrote anyway: TTL expiry or prefix below the model's minimum cacheable
   length — Haiku's minimum is thousands of tokens, so trivial sessions
   may legitimately never cache).

**Wiring status: LANDED (`1d9e8f5`).** `runTurn` builds every request via
`applyCacheControl`; `TurnDeps.ledger` (owned by the caller so it spans
turns — created in `runApp` and in `main()`) predicts before each request
and reconciles after; verdict notes land in `TurnStats.notes` and render
as `⚠` lines under the stats line, which shows cache r/w + hit rate.
Live-verified through the proxy: turn 1 `cache 0r/8516w` with the
below-minimum warning firing correctly, turn 2
`3 in · cache 8516r/59w (99% cached)`; wire trace showed breakpoints at
`system[0]` + last message block.

Known limits: ledger is in-memory per process (restart → first prediction
"unknown", verification re-syncs); server cache state is inferred, never
observed directly.

### 4.5 `cost.ts` — dollar meter (pure)

- `resolveRates(model, pricing)`: exact key on the **server-reported**
  model id, then a date-suffix-stripped fallback
  (`claude-haiku-4-5-20251001` → `claude-haiku-4-5`). Unknown → `null`,
  never a guessed price.
- `computeCostUsd(usage, rates)`: input/output at their rates; cache reads
  at `cacheInputPerMTok`, cache writes at `cacheWritePerMTok`, both
  falling back to the full input rate (conservative).
- Wiring: `TurnDeps.pricing` → per-request accumulation into
  `TurnStats.costUsd` (`null` + one `⚠ no pricing for <model>` note when
  any request is unpriced). Stats line shows `$…`; `/usage` totals the
  session and flags unpriced turns.
- Verified against aap: same session, our meter $0.0170 vs aap's
  independent trace-derived $0.017.

### 4.6 `compact.ts` — compaction (see docs/protocol/compaction.md)

- The compact request is a **pure append to the cached prefix** — same
  tools (never dropped: removing them would re-bill the whole history at
  1.0x instead of 0.1x), same system, same messages, plus one instruction
  user message (`COMPACT_INSTRUCTION`, our own text: Goal / State / Key
  context / Next steps, summary-only — no `<analysis>` scratchpad).
- `runCompact`: streams the summary, then appends a user event flagged
  `isCompactSummary: true` (Claude's field name — fixture-compatible).
  Empty summary → throw, tree untouched. Returns dropped-message count,
  summary size, usage, cost.
- Reducer boundary (§4.1): the API-visible conversation restarts at the
  **last** `isCompactSummary` event on the active path; everything before
  it stays on disk (append-only, still rewindable).
- Triggers: `/compact`, and auto-compact after any turn whose
  `lastRequestInputTokens` ≥ `autoCompactAtTokens` (config, default 160k,
  0 = off, mid-session adjustable via `/config`).
- Post-compact economics are surfaced honestly: the next request's ledger
  verdict is `predicted-regen (message[0] changed)` — a deliberate,
  visible prefix reset.

### 4.7 Tool-set configuration

The enabled tool set controls **schema presence** (not just permission) —
it is the head of the cache prefix. Precedence: `--tools` flag >
`[tools].enabled` in config > all registry tools.

- Registry: `setEnabled(names|null)` / `isEnabled` / `enabledNames`;
  `schemas()` filters **preserving canonical order** (identical subsets →
  identical prefix bytes). Dispatch rejects disabled tools before the
  permission gate (`tool disabled for this session: X`).
- `/config` → Tools (clack multiselect, read-only/mutating hints):
  - before the first request: applies immediately + _session-only /
    permanent_ choice; the applied set is recorded as a chained `config`
    event (`meta.tools`) for audit/replay;
  - after the first request: **never applies mid-session** (would
    regenerate the entire cache); only _save as default for future
    sessions_ is offered.
- `/config` → Auto-compact threshold: prefix-safe, applies immediately,
  optional permanent save.
- Permanent saves go through `saveConfigPatch` (parse → merge →
  stringify; comments in the TOML are not preserved — documented v1
  tradeoff).

## 5. Transport (`src/transport/anthropic.ts`)

Explicit `fetch` + hand-rolled SSE parsing; no SDK.

- `POST {baseUrl}/v1/messages`, headers `x-api-key`,
  `anthropic-version: 2023-06-01`; body `{model, max_tokens: 8192,
stream: true, system, tools, messages}`.
- Non-2xx → `ApiError(status, first 400 body chars)`; no retries (YAGNI
  until a recorded failure demands them).
- SSE events handled: `message_start` (model + initial usage),
  `content_block_start` (text/tool_use skeleton), `content_block_delta`
  (`text_delta` → `onText`; `input_json_delta` → accumulate partial JSON),
  `message_delta` (stop_reason, usage), `error` → throw. `ping`,
  `content_block_stop`, `message_stop` intentionally ignored.
- Result: ordered content blocks (tool_use inputs JSON-parsed), stopReason,
  merged usage, server-resolved model id.
- `AbortSignal` passed straight to `fetch`; abort surfaces as `AbortError`.

`ANTHROPIC_BASE_URL` override is how `aap run` routes stackpilot through
the profiler proxy — every session can be recorded and cost-audited
exactly like Claude Code's.

## 6. Tools (`src/tools/`)

Contract (`types.ts`): `{name, description, inputSchema, readOnly,
execute(input, cwd) → {output, isError?}}`. Validation helpers throw
`ToolInputError`; the registry converts it to an error result. Unexpected
exceptions are NOT swallowed — they bubble (fail fast).

Schemas stay **Claude-familiar on purpose** (PLAN #9): models are trained
on these shapes; we change implementations, not signatures.

| Tool      | readOnly | Notes                                                                                                                                                                                  |
| --------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read      | yes      | line-numbered `N: text`, offset/limit, 2000-line / 2000-char-per-line caps, 40k output cap with truncation marker                                                                      |
| Write     | no       | mkdir -p parents, byte count reported                                                                                                                                                  |
| Edit      | no       | exact-string replace; **unique match required** unless `replace_all`; identical old/new rejected; match count reported                                                                 |
| Bash      | no       | `bash -c` per call (persistent shell deliberately deferred), cwd-scoped, default 120s / max 600s timeout, SIGKILL on timeout, stdout+stderr merged, 30k cap, non-zero exit → `isError` |
| Grep      | yes      | ripgrep: `--line-number --no-heading --max-count 50`, optional path + `--glob`; exit 1 → "no matches"; missing rg → explicit error                                                     |
| Glob      | yes      | own walk (no deps): skips `.git node_modules dist .stackpilot`, depth ≤ 12, ≤ 5000 files scanned, ≤ 200 results, `globToRegExp` supports `** * ?`                                      |
| TodoWrite | yes      | replaces session todo list; strict shape validation; state held in registry, rendered by the TUI                                                                                       |

`index.ts` — registry. **Tool order is part of the cache prefix: append
new tools at the END only** (comment enforced by review, invariant by
convention). `executeTool` wraps dispatch.

## 7. TUI (`src/tui/`)

### 7.1 Architecture

Inline rendering: transcript stays in native terminal scrollback; readline
owns the input line between turns (↑ history for free); clack renders
menus; a keypress listener is armed only while a turn runs so Esc aborts.

- `ansi.ts` — zero-dep styling (auto-disabled when not a TTY / NO_COLOR),
  `CLEAR_LINE`, spinner frames.
- `render.ts` — **pure formatters** (all unit-tested): banner, help,
  `toolStartLine` (`⏺ Bash(npm test)`), `toolEndLine` (`✓/✗ first line
(+N lines)`), `statsLine`, `usageSummary`, `todoBox`, `toolArgPreview`
  (command > file_path > pattern), `permissionLabel`,
  `permissionPromptPlain`, `formatAge`, `interrupted`.
- `app.ts` — the only interactive I/O shell: Spinner (80ms stderr ticker),
  InterruptController, the turn loop, slash commands
  (`/help /todos /usage /exit`), Ctrl+D → clean exit.

### 7.2 Permission flow

Read-only tools run without prompting. Mutating tools:

1. session allowlist hit → run;
2. else clack `select`: **Allow once / Allow `<tool>` for this session /
   Deny**;
3. menu cancel (Esc/Ctrl+C) → mapped to turn interrupt (AbortError →
   backfill invariant §4.2).

Headless (`-p`): `--yolo` allows everything; otherwise mutating tools are
denied (deny-by-default). Plain fallback (piped stdin): y/N text prompt,
exact `y`/`yes` only.

### 7.3 TTY lessons (hard-won, all regression-relevant)

1. **Never `pause()` stdin around readline.** promises-readline `question()`
   resumes only the Interface's own pause state, not the stream; a paused
   TTY stops ref'ing the event loop and node exits 0 mid-await. (Bug:
   "kicked out after first turn".)
2. **Never toggle raw mode behind readline's back.** The Interface enables
   raw at creation and expects it for its lifetime; flipping it off
   re-enables kernel echo → every submitted line prints twice (kernel +
   readline). The interrupt listener therefore only attaches/detaches.
3. **clack drops raw mode AND pauses stdin when a prompt closes** →
   `restoreReadlineTty()` re-asserts raw _and resumes_ after every clack
   interaction, or lessons 1–2 repeat. (The permission path originally
   survived only because `interrupt.arm()` resumes as a side effect; the
   `/config` path exposed the drain: clean exit 0 right after
   "tools enabled" printed.)
4. **Exact-match approvals.** Type-ahead during streaming lands in the next
   prompt; `startsWith("y")` could auto-approve a mutation from buffered
   noise.

## 8. CLI (`src/cli/main.ts`)

```
stackpilot                 TUI (TTY) or plain loop (piped stdin), new session
stackpilot -c              continue: picker when >1 session (TTY), else newest
stackpilot -p "…"          one headless turn, fresh session unless -c
stackpilot --yolo          skip permission prompts
stackpilot --model <id>    model override
stackpilot --tools A,B,C   enable only these tools (schema presence)
```

- Unknown args → exit 2 with message; unknown tool names in `--tools` →
  exit 2 listing valid names.
- `-c` picker: `id.slice(0,8) · age · first-prompt preview` (top 10),
  cancel exits 0. Single session skips the menu.
- Config file (`~/.stackpilot/config.toml`, or `$STACKPILOT_CONFIG`;
  `config.example.toml` shipped): `[pricing."<model>"]` blocks
  (aap-compatible, copy-paste between the tools), `[tools].enabled`,
  `autoCompactAtTokens`. Missing file = defaults; malformed = fail fast.
- Credential resolution (`src/config.ts`): API key from
  `ANTHROPIC_API_KEY`, else the `env` block of `~/.claude/settings.json`
  (documented convenience — same key Claude Code uses; never persisted,
  never logged); missing → `ConfigError`, exit 1. Model: `--model` >
  `STACKPILOT_MODEL` > `ANTHROPIC_MODEL` > `claude-haiku-4-5`. Base URL:
  `ANTHROPIC_BASE_URL` (trailing slash stripped) or api.anthropic.com.
- Per-turn stats line to stderr: requests, tools, in/out, cache r/w, $.
- Headless mode has no auto-compaction and no `/config` (TUI-only).

## 9. Observability & dogfooding

Run through the profiler:

```bash
aap serve                                   # terminal 1
AAP_SESSION_ID=my-test aap run --meta scenario=x \
  npx tsx ~/Projects/aitools/stackpilot/src/cli/main.ts --yolo -p "…"
```

aap records byte-faithful traces (secrets redacted), classifies request
kinds, computes cost from its pricing TOML. `aap parse --all` backfills
after pricing changes. This loop is how every stackpilot feature gets
cost-verified against Claude Code baselines (`aap compare` for A/B in P3).

## 10. Testing

`vitest`, 83 tests green at last commit. Philosophy: pure logic gets
tests; thin I/O shells get live tmux verification instead.

| Suite             | Anchors                                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reducer.test.ts` | **golden fixture**: real Claude rewind transcript → exact tree numbers; synthetic linear/rewind/metadata cases; compact-summary boundary incl. last-summary-wins        |
| `loop.test.ts`    | tool_result backfill on aborted permission; tool_use/tool_result pairing; disabled tool rejected before the permission gate (fake streams, temp-home stores)            |
| `tools.test.ts`   | Read numbering/offset; Edit unique-match/ambiguous/replace_all/missing; globToRegExp table; registry enabled-set filtering (order preserved, empty set, unknown names)  |
| `store.test.ts`   | summariesFor ordering + previews (utimes-controlled); firstUserText string/block/tool_result-skip/null                                                                  |
| `render.test.ts`  | tool lines, stats cache visibility + hit % + $, usage summing + unpriced flag, permissionLabel, formatAge table                                                         |
| `cache.test.ts`   | marker placement; stripCacheControl; fingerprint diffs (incl. marker movement ≠ divergence); ledger verdicts; **two-turn byte-stable prefix invariant through runTurn** |
| `cost.test.ts`    | rate resolution (exact/date-stripped/unknown); per-counter billing math; cache-rate fallbacks; formatUsd                                                                |
| `config.test.ts`  | defaults on missing file; pricing/tools/threshold parsing; fail-fast on malformed TOML/values; saveConfigPatch merge preserves other sections; file creation            |
| `compact.test.ts` | request builder (instruction last, marker on it, tools kept); runCompact happy/empty/error; reducer restart + continuation on top of the summary                        |

Live verification pattern: tmux `send-keys`/`capture-pane` against a real
TTY (the pty quirks in §7.3 are invisible to piped tests), with traffic
through aap so the wire side is provable from traces.

## 11. Environment variables

| Var                                    | Effect                                               |
| -------------------------------------- | ---------------------------------------------------- |
| `ANTHROPIC_API_KEY`                    | credential (or settings.json fallback)               |
| `ANTHROPIC_BASE_URL`                   | transport target (aap proxy routing)                 |
| `STACKPILOT_MODEL` / `ANTHROPIC_MODEL` | model selection (default `claude-haiku-4-5`)         |
| `STACKPILOT_CONFIG`                    | config file path (default ~/.stackpilot/config.toml) |
| `NO_COLOR`                             | disable ANSI styling                                 |

## 12. Deliberate omissions (YAGNI until recorded need)

Persistent Bash shell, retries/backoff, MCP, hooks, sandboxing, file
checkpoints (git worktrees cover it), markdown/diff rendering (P5,
OpenTUI-vs-Ink pending the Node ≥ 22 decision), comment-preserving TOML
writer, mid-session model switching (would need the same deferral logic
as tools — revisit with P3 model routing), auto-compaction in headless
mode.
