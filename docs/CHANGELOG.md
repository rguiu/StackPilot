# Changelog

Chronological record of everything done, keyed to commits. Costs are real
(Haiku via the aap proxy); verification evidence is quoted from live runs.

## Phase 0 — Recon (`7191be6`, `16c3d3f`)

**Prerequisite work in the profiler repo (ai-agent-profiler):** Haiku 4.5
pricing added to `config.example.toml` / `config.toml` /
`~/.aap/config.toml` (`$1 in / $5 out / $0.10 cache-read / $1.25 cache-write
per MTok`; the $2 1h-write rate is not representable in aap's schema — noted
there). All existing traces re-costed with `aap parse --all`.

**Recordings** (5 scenarios, ~$0.40 total, all through `aap serve` +
`aap run claude` with every model alias pinned to `claude-haiku-4-5-20251001`
in `~/.claude/settings.json`):

| scenario           | what it captured                                            |
| ------------------ | ----------------------------------------------------------- |
| fresh-baseline     | system prompt, tool schemas, first cache writes             |
| multi-turn-edits   | stack growth, cache reads across 3 chained turns            |
| compact            | `/compact` summarization request (kind detected by aap)     |
| subagent-plan-todo | Task sidechains (`search` kind), TodoWrite                  |
| rewind-resume      | transcript tree branching (user-driven TUI rewind) + resume |

**Protocol findings** extracted to `docs/protocol/` via
`scripts/extract-protocol.mjs`:

- Claude Code 2.1.212 ships **29 tools** (Agent, background Task\*, worktree,
  cron, notification tools — far beyond the documented set).
- Cache breakpoints observed at `system[1]`, `system[2]` + a **moving
  breakpoint on the last user message**.
- Client sends undated `claude-haiku-4-5`; server resolves the dated
  snapshot id.
- Startup preflight `HEAD <base>/` always 404s upstream (liveness probe
  only — any response means online).
- Transcript = **event tree** (`parentUuid → uuid`), not a log: 51 events,
  25 active, 6 abandoned after one rewind; only `user`/`assistant` events
  (24/51) are API-visible; `file-history-*` events implement "Restore code".
- Token economics: ~1.6k visible conversation tokens vs **305k cache-read /
  196k cache-write** — the static prefix dominates cost.

## P1 — Working agent (`1a36c98`, tagged `v0.1` at `bde20f6`)

~1,400 LOC TypeScript, zero runtime deps at this point:

- `session/`: append-only JSONL event tree, Claude-compatible layout,
  fail-fast validation at the write boundary.
- `core/reducer.ts`: pure newest-leaf walk; **replays the recorded Claude
  rewind transcript bit-exact** (25/6/2/2, 19 messages, follows the rewound
  branch) — same engine for our sessions and theirs.
- `transport/`: streaming `/v1/messages` client, hand-rolled SSE, no SDK.
- `tools/`: Read, Write, Edit, Bash, Grep (rg), Glob, TodoWrite —
  Claude-familiar schemas, our implementations, fixed registry order
  (registry order is cache-prefix order).
- `core/loop.ts`: injected-dependency turn loop with permission gating.
- `cli/`: REPL + `-p` headless + `-c` resume + `--yolo`.
- Smoke-tested through the aap proxy: 4 requests, 3 tool calls, **$0.0086**,
  session resumable, chain intact.

## TUI (`eeb260e`) + two production bugs (`ed331eb`, part of `91ea9a4`)

Custom inline TUI (no Ink/React): transcript in native scrollback, readline
owns the input line, spinner, Esc-interrupt via AbortSignal, slash commands
(`/help /todos /usage /exit`), Ctrl+D clean exit, non-TTY fallback loop.

Bugs found by real usage, root-caused and regression-documented:

1. **"Kicked out after first turn"** — `disarm()` paused stdin; promises-
   readline never resumes the underlying stream, the paused TTY stopped
   ref'ing the event loop, node exited 0 mid-await. Fix: never pause stdin.
2. **Double-echoed input lines** — toggling raw mode behind readline's back
   re-enabled kernel echo; every submitted line printed twice (kernel +
   readline). Fix: the interrupt listener only attaches/detaches; TTY state
   belongs to readline.
3. **Permission hardening** (found via tmux-driven Esc testing): type-ahead
   could leak into prompts and `startsWith("y")` could approve a mutation
   from buffered noise → exact `y`/`yes` only; Esc during a prompt now
   cancels the turn; **tool_use/tool_result backfill invariant** added to
   the loop (interrupting a tool phase persists synthetic
   `[interrupted by user]` results so the tree stays API-valid) —
   unit-tested and verified live (`9 * 9` worked right after a cancelled
   `Write`).

## Widgets — @clack/prompts (`91ea9a4`)

Decision: keep the inline architecture; adopt clack (TypeScript, ~80KB) for
menus only. Readline keeps the input line (↑ history); the Esc listener
stays hand-rolled.

- Permission prompt → arrow-key select: **Allow once / Allow `<tool>` for
  this session** (in-memory allowlist) **/ Deny**; menu cancel maps to turn
  interrupt.
- `-c` with multiple sessions → picker (`id · age · first-prompt preview`
  via `SessionStore.summariesFor`); single session skips the menu.
- Third TTY lesson captured: **clack drops raw mode on prompt close** →
  `restoreReadlineTty()` re-asserts it (else bug #2 returns).
- Fix en route: bare `-p` no longer silently resumes the newest session.
- tmux-verified end-to-end; 43 tests at this point.

## Docs (`c1efa2d`, `88c7e85`)

- PLAN.md phase statuses (P0/P1/TUI done).
- `docs/IMPLEMENTATION.md`: full reference — architecture, module-by-module
  behavior, invariants, formats, TTY lessons, test inventory.

## P2a — Prompt caching + client-side cache awareness (`1d9e8f5`)

The cache lives on Anthropic's servers; stackpilot owns the **key**:

- `applyCacheControl`: static breakpoint (system block, covers
  tools+system) + moving breakpoint (last block of last message) — the
  placement recorded from Claude Code in Phase 0.
- `prefixFingerprint` / `diffFingerprints`: sha256 per prefix component
  over marker-stripped JSON; predicts exactly which suffix a stack
  mutation would re-write (the economic primitive for P3 policies).
- `CacheLedger`: predict before each request, reconcile with the server's
  `cache_read/creation` counters after →
  `first | hit | predicted-regen | unexpected-regen`; verdicts surface as
  `⚠` notes under the stats line, which now shows hit rate.
- Tests: 55 total, including the **two-turn byte-stable prefix invariant**
  driven through `runTurn`.

Live verification (session `sp-p2-cache`, through the proxy):

```
turn 1: 2 req · 1 tools · 1324 in · cache 0r/8516w (0% cached)
        ⚠ cache miss despite stable prefix … below the model's minimum cacheable length
turn 2: 1 req · 0 tools · 3 in · cache 8516r/59w (99% cached)
```

Turn 1's warning is the ledger working: the 1.3k static prefix sits under
Haiku's minimum cacheable length until the tool result fattens the prefix.
Turn 2 paid full price for **3 tokens**. Wire check confirmed breakpoints
at `system[0]` + last message block.

## P2b — Cost meter, compaction, /config (`87d4d59`, `2889626`, + this commit)

**Cost meter (`87d4d59`):** `~/.stackpilot/config.toml` (smol-toml; 2nd
runtime dep) with aap-compatible `[pricing]` blocks; `core/cost.ts` rate
resolution (exact → date-stripped, unknown → null + note, never guess);
`$` in the stats line, session total in `/usage`. Cross-check: our meter
**$0.0170** vs aap's independent **$0.017** from raw traces.

**Compaction (`2889626`):** compact request = pure append to the cached
prefix (tools deliberately KEPT — dropping them would re-bill the history
at 1.0x instead of 0.1x; `docs/protocol/compaction.md` documents the
recorded Claude behavior + our divergences). Summary persisted as a
`isCompactSummary` user event; reducer restarts the conversation at the
last summary; tree stays append-only. `/compact` + auto-compact at
`autoCompactAtTokens`. Live (5k threshold): 8.5k-token turn →
`✂ compacted (auto): 4 messages → 1444-char summary · $0.0026`, next turn
1613 in with the ledger reporting `cache regen (expected): message[0]`.

**`/config` + tool-set control (this commit):** tools = schema presence =
head of the cache prefix. `/config` → Tools multiselect (order-preserving
filter, empty allowed): before the first request applies immediately
(+ session-only/permanent choice, recorded as a chained `config` event);
mid-session **never applies** — only "save as default for future
sessions" (prefix-safe by construction). `/config` → auto-compact
threshold applies mid-session (prefix-safe) with optional save. `--tools`
flag for headless A/B. Wire-verified: 5 of 7 schemas on the wire after
deselecting Write+Bash; deferred save produced
`[tools] enabled = ["Edit","Grep","Glob","TodoWrite"]`.

**Fifth TTY lesson:** clack prompts pause stdin on close → chained clack
flows drained the event loop and node exited 0 right after
"tools enabled" printed (the permission path had survived only because
`interrupt.arm()` resumes stdin as a side effect). `restoreReadlineTty()`
now re-asserts raw **and resumes**.

Tests: 83. Gates green.

## Engineering memory — SearchHistory + aap FTS index

The differentiator Claude Code doesn't have: **searchable memory over
every recorded session**, across agents, models, and projects.

**aap side** (branch `feat/search-index`, commit `74c7e84`): FTS5
`search_docs` table indexes the per-request **delta** (last request
message, assistant response text, tool name + input JSON) — system
prompts/tool schemas excluded, full-history duplication avoided. Built
idempotently during `aap parse`; rebuildable with `parse --all`;
`GET /search?q=` + `aap search` CLI with hostile-syntax fallback.
272 tests.

**stackpilot side:** `SearchHistory` tool (read-only, appended LAST in
the registry — cache-prefix rule), origin auto-derived from the proxy
base URL, 5s timeout, graceful degradation when aap is old/absent.
90 tests.

**Live proof** (session `sp-memory-demo`): asked "have we ever worked on
safeDivide?" — the agent called SearchHistory and correctly reconstructed
cross-agent history: `sp-rewind` (interactive **Claude Code** session:
divide→safeDivide rename) and `sp-p1-smoke` (stackpilot's own first smoke
test: the RangeError comment), with paths and timestamps. One tool call,
$0.0051.

## Cumulative state

- ~2,700 LOC src + 9 test suites (83 tests), gates: typecheck / vitest /
  prettier all green.
- Two runtime dependencies (`@clack/prompts`, `smol-toml`).
- Every feature cost-verified through the aap proxy; golden fixtures pin
  the reducer, the prefix invariant, and the compact boundary; the cost
  meter is cross-validated against aap's independent implementation.
- **P2 complete.** Next: P3 (context policies: tool-result paging, read
  dedupe, eviction — priced ahead of time by the fingerprint diff), P4
  (subagents), P5 (rich rendering; Node ≥ 22 decision pending).
