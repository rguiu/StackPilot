# stackpilot — Plan

A lean, cost-optimal coding agent with a fully controllable message stack.
Matches Claude Code's behavioral core, minus the low-value surface. Built in
TypeScript, instrumented from day 1 through the
[ai-agent-profiler](../ai-agent-profiler) (`aap`) proxy.

**Strategy in one line:** match the behavioral core (loop, tools, session
tree, caching, compaction), measure everything, and win on context-stack
control + cost routing — not on feature count.

## Decisions

| Decision      | Choice                                                     |
| ------------- | ---------------------------------------------------------- |
| Language      | TypeScript, Node >= 20, ESM, strict                        |
| Interface     | Streaming REPL first; TUI later (Phase 5, maybe never)     |
| Scope         | Behavioral parity where it pays; pick-and-choose otherwise |
| Provider v1   | Anthropic Messages API only, behind a thin `transport/`    |
| Conventions   | Mirror aap: vitest, prettier, TOML config, zero-framework  |
| Observability | All traffic through `aap` proxy; profiler = troubleshooter |
| Repo          | This repo (`stackpilot`); name may change                  |

## Feature table (Claude Code → stackpilot verdict)

| #   | Feature                          | Claude Code behavior                      | Verdict        | Angle                                                                                          |
| --- | -------------------------------- | ----------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| 1   | Streaming agent loop             | messages[] → tool_use → tool_result       | Keep           | Foundation, ~400 LOC                                                                           |
| 2   | Prompt caching                   | cache_control breakpoints                 | Improve        | Enforce append-only prefix via reducer types; make cache regeneration impossible, not detected |
| 3   | Auto-compaction                  | Wholesale summarize near context limit    | Improve        | Fine-grained eviction first (#12); compact as last resort                                      |
| 4   | System-reminders                 | Injected mid-stack (todo, CLAUDE.md)      | Improve        | Tail-only injection + token budget; measure cache impact                                       |
| 5   | Memory file hierarchy            | enterprise/user/project/local CLAUDE.md   | Simplify       | user + project only                                                                            |
| 6   | Small-model routing              | Haiku for title/recap/webfetch/quota      | Improve        | Route utility calls to any cheap provider — or drop the calls                                  |
| 7   | Title / recap / quota calls      | Extra background requests                 | Drop           | Low value per token; title = first-prompt truncation                                           |
| 8   | Thinking budgets                 | think/ultrathink                          | Keep           | Pass-through param                                                                             |
| 9   | Core tools (Read/Edit/Bash/Grep) | RL-familiar schemas                       | Keep schemas   | Deviating from trained tool shapes degrades the model — change bodies, not signatures          |
| 10  | Tool-result truncation           | Truncate, info lost                       | Improve        | Page it: store full locally, send slice + "expand" tool                                        |
| 11  | Repeated file reads              | Re-sends whole file each read             | Improve        | Supersede stale copies of the same file in the stack (profiler's top finding)                  |
| 12  | Message-stack mutation           | Only wholesale compact                    | New            | Pluggable pure context policies (dedupe, evict old tool_results, collapse failed loops)        |
| 13  | TodoWrite                        | Steering signal                           | Keep           | Cheap, high value                                                                              |
| 14  | Task/subagents                   | Isolated context sidechains               | Keep (P4)      | Biggest legitimate context saver                                                               |
| 15  | Session JSONL tree               | parentUuid tree, rewind/branch            | Keep + Improve | Event-sourced reducer → deterministic replay of golden traces                                  |
| 16  | /resume                          | Reload active path                        | Keep           | Falls out of #15                                                                               |
| 17  | File checkpoints                 | Rewind file state                         | Defer          | Git worktrees cover it                                                                         |
| 18  | Permissions/modes/sandbox        | Rules, acceptEdits, OS sandbox            | Simplify       | Allowlist + y/n prompt; plan mode later; no sandbox v1                                         |
| 19  | Hooks / MCP / skills / slash     | Extensibility surface                     | Defer/Drop     | Big surface, little value now; MCP maybe later                                                 |
| 20  | WebFetch/WebSearch/images        | —                                         | Defer          | Not on the cost-critical path                                                                  |
| 21  | Headless `-p` / stream-json      | Scripting mode                            | Keep           | Needed for A/B benchmarking                                                                    |
| 22  | /cost meter                      | On demand                                 | Improve        | Live per-turn tokens/cost/cache-hit% in the prompt line (pricing TOML)                         |
| 23  | TUI (markdown, diffs, vim)       | Rich                                      | Phase 5        | Plain streaming REPL first                                                                     |
| 24  | IDE/auto-update/telemetry        | —                                         | Drop           | aap is the (local) telemetry                                                                   |
| 25  | Startup preflight                | HEAD base-URL root (always 404s upstream) | Drop           | Or probe /v1/models for a meaningful status                                                    |

## The "better than Claude Code" bets

1. **Cache-stability by construction** — append-only stack invariant enforced
   in types + a test asserting byte-stable prefixes across turns.
2. **Context policies as pure functions** (`stack → stack`), composable and
   configurable per session.
3. **A/B harness** — same task, policy on/off, compared with `aap compare`;
   evidence-driven pruning instead of vibes.
4. **Cost routing** — main model premium, utility calls cheap provider,
   per-subsystem token budgets (system <= X, tools <= Y, reminders <= Z).
5. **Deterministic replay** — event-sourced sessions debuggable to any state.
6. **Engineering memory** _(shipped)_ — the aap proxy indexes every recorded
   session (FTS5 over per-request deltas: prompts, responses, tool calls);
   the `SearchHistory` tool lets the agent ask "have we solved this
   before?" across agents, models, and projects. Claude Code has nothing
   comparable.

## Phases

- **P0 Recon — DONE:** 5 scenarios recorded through aap (haiku); protocol
  docs + golden fixtures extracted. Missing: an organic auto-compact trace,
  compaction.md/reminders.md deep-dive (sp-compact trace is on disk).
- **P1 — DONE (v0.1):** REPL/TUI + streaming loop + 7 tools + permission
  gate + JSONL event tree + resume. Reducer replays Claude transcripts
  bit-exact. Dogfooded through the aap proxy.
- **P1.5 TUI — DONE (pulled forward from P5):** custom inline TUI +
  @clack/prompts widgets: permission select with session allowlist,
  -c session picker, Esc interrupt, spinner, slash commands.
- **P2a caching — DONE:** cache_control breakpoints (static + moving),
  client-side fingerprint ledger predicting/verifying hits and regens,
  hit-rate in the stats line, byte-stable prefix invariant test.
  Live: 99% cached on turn 2 of the verification session.
- **P2b — DONE:** pricing config + $ cost meter (cross-validated against
  aap: $0.0170 vs $0.017); /compact + auto-compact as append-only
  isCompactSummary events with prefix-reuse economics; /config (tools
  multiselect with schema-presence control + prefix-safe deferral rules,
  auto-compact threshold) + --tools flag.
- **P3a — DONE:** instruction system + system prompt + hooks + session memory
  - CLAUDE.md hierarchical loading (walk from cwd → git root + ~/.stackpilot/)
  - System prompt enrichment (git context, platform, security guardrails, coding conventions)
  - Hooks v1: pre-tool + post-tool (advisory, fail-open, 5s timeout)
  - SKILL.md loading + Skill tool (`.stackpilot/skills/<name>/SKILL.md`)
  - Tier 2 session memory: structured metadata index at `~/.stackpilot/memory/`
- **P3b — DONE:** context policies (#10 tool-result paging, #11 read dedupe, #12 stack eviction
  — regen cost priced ahead by the fingerprint diff) + cheap-model routing +
  A/B via aap compare + richer Grep schema + third cache breakpoint.
- **P4 — DONE:** subagents (Agent tool, isolated context sidechains, explore/general types).
- **P5 — DONE:** rich rendering — streaming markdown, diff colorization, inline code blocks;
  stream-json headless output (`--json`); thinking-budget pass-through;
  deny-with-feedback on permission prompts; `!` prefix for direct shell commands.

## P3a design decisions

| Decision               | Choice                                                          | Rationale                                                            |
| ---------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- |
| CLAUDE.md walk-up stop | Git root + `~/.stackpilot/CLAUDE.md`                            | Project scope stops at repo boundary; user preferences at home       |
| CLAUDE.md filename     | `.stackpilot/CLAUDE.md` preferred, bare `CLAUDE.md` as fallback | Namespaced by default, compatible with existing Claude Code projects |
| CLAUDE.md re-read      | Once at session start                                           | Cache stability: same system prompt = same prefix = cache hit        |
| Hook points v1         | pre_tool + post_tool + session_start + session_end              | Full lifecycle coverage; stdout → system-reminder for model context  |
| Hook I/O               | JSON on stdin + env vars                                        | Rich structure, trivially consumed by any scripting language         |
| Hook fail mode         | Fail-open (log, continue)                                       | Advisory initially; configurable later (`onFailure: "warn"           | "block"`) |
| Hook timeout           | 5s hard limit, SIGKILL                                          | Predictable, won't stall the agent                                   |
| Hook output routing    | stdout → both system-reminder + terminal                        | Model sees context; user sees status. Per-hook routing deferred.     |
| Hook config            | `config.toml` `[hooks]` section                                 | Single config surface                                                |
| Per-tool overrides     | **Deferred.** `hooks.pre_tool.Bash` would override global.      | Not in v1; single global hook per point.                             |
| Multi-script hooks     | **Deferred.** `command = ["lint.sh", "format.sh"]` arrays.      | Single `command` string per hook point for v1. Array support later.  |

### Future hook extensions (documented, not implemented)

Additional hook points that fit the runner infrastructure without changes:

| Hook Point           | Trigger                                                        | Use case                                                     |
| -------------------- | -------------------------------------------------------------- | ------------------------------------------------------------ |
| `user_prompt_submit` | User submits a prompt                                          | Inject context, check for banned commands, redirect to skill |
| `pre_compact`        | Before session compaction                                      | Snapshot state, capture decisions before summarization       |
| `post_compact`       | After session compaction                                       | Update memory index with decisions from compacted context    |
| `pre_turn`           | Before model processes user message                            | Inject dynamic git diff, file drift warnings                 |
| `post_turn`          | After model response + tools                                   | Desktop notification, capture decisions, update task list    |
| `notification`       | After significant events                                       | Conditional push/Slack/email (separate from post_turn)       |
| Skill directory      | `.stackpilot/skills/<name>/SKILL.md` + `~/.stackpilot/skills/` | Project-level wins, user-level fallback                      |
| Skill invocation     | Skill tool (model can self-invoke)                             | Let the model decide when to use skills                      |
| Session memory index | `~/.stackpilot/memory/`                                        | Local, portable, survives proxy restarts                     |
| Memory extraction    | On session close via post-turn hook                            | Natural lifecycle, no polling                                |

## Phase 0 runbook

StackPilot was built by recording Claude Code's wire behavior through the
[ai-agent-profiler](https://github.com/anomalyco/ai-agent-profiler) (`aap`) — a
local reverse proxy that sits between any LLM client and the API, capturing
request/response pairs, measuring token usage and cache behavior, and indexing
everything in a FTS5 database for later analysis.

```bash
# Clone and run from source (no npm package yet)
git clone https://github.com/rguiu/ai-agent-profiler
cd ai-agent-profiler
npm install
npm run dev
# → Listening on http://127.0.0.1:8080
# → Proxies to https://api.anthropic.com

# In another terminal, record a session:
ANTHROPIC_BASE_URL=http://127.0.0.1:8080/anthropic claude

# Or use the aap CLI (from the same repo) to tag sessions:
npx tsx src/cli/aap.ts run --meta scenario=edit-loop claude "fix the bug"

# StackPilot runs through aap for cost verification:
aap run npx tsx path/to/stackpilot/src/cli/main.ts
```

Aap provides:

- **Recording:** every request/response body, headers, timing, and cost, saved as
  NDJSON trace files
- **Comparison:** `aap compare --base <ref> --head <exp>` for A/B testing context
  policies
- **FTS search:** FTS5 index of all recorded sessions — the backing store for
  StackPilot's `SearchHistory` tool
- **Cost verification:** independent token/cost counters cross-validated against
  StackPilot's own cost meter

Recording (Haiku, all aliases pinned in `~/.claude/settings.json`):

| Scenario           | What it exercises                            | Status   |
| ------------------ | -------------------------------------------- | -------- |
| fresh-baseline     | system prompt, tool schemas, cache writes    | recorded |
| multi-turn-edits   | stack growth, cache reads, edit loops        | recorded |
| compact            | /compact summarization protocol              | recorded |
| subagent-plan-todo | Task sidechains, plan mode, system-reminders | recorded |
| rewind-resume      | transcript tree branching, resume reload     | recorded |

Analysis targets in `docs/protocol/`:

- `system-prompt.md` — structure and sizes, what varies per request kind
- `tools.json` — exact tool schemas (keep signatures, rewrite internals)
- `cache-breakpoints.md` — cache_control placement per turn, what breaks the prefix
- `compaction.md` — compact prompt + reminder formats/injection points
- `transcript-model.md` — disk tree <-> in-memory stack <-> API body mapping

Golden traces live in `fixtures/traces/` (already secret-redacted by aap).

**Phase 0 done =** protocol docs + fixtures committed; P1 loop is then written
against observed behavior, not guesses.

## Known wire facts (from recordings so far)

- Model resolves to `claude-haiku-4-5-20251001`; request kinds observed:
  `main`, `search` (subagent), `title`, `recap`.
- Claude Code startup sends `HEAD <base-url>/` as a liveness probe; the
  Anthropic root always answers 404 — any response means "online".
- Requests go to `POST /v1/messages?beta=true`; UA is `Bun/1.4.0` for
  preflight, `claude-cli/<ver>` for API calls.
