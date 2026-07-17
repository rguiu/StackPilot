# stackpilot — Plan

A lean, cost-optimal coding agent with a fully controllable message stack.
Behavioral clone of Claude Code's core, minus the low-value surface. Built in
TypeScript, instrumented from day 1 through the
[ai-agent-profiler](../ai-agent-profiler) (`aap`) proxy.

**Strategy in one line:** clone the behavioral core (loop, tools, session
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
- **P3 — NEXT:** context policies (#10 tool-result paging, #11 read
  dedupe, #12 stack eviction — regen cost priced ahead by the fingerprint
  diff) + cheap-model routing + A/B via aap compare.
- **P3 — NEXT:** context policies (#10 tool-result paging, #11 read
  dedupe, #12 stack eviction — regen cost priced ahead by the fingerprint
  diff) + cheap-model routing + A/B via aap compare.
- **P4:** subagents (Task).
- **P5 (remainder):** rich rendering — markdown, diffs, syntax highlight;
  decide OpenTUI vs Ink (Ink 7 needs Node >= 22; currently on 20).
  Also: stream-json headless output, thinking-budget pass-through,
  deny-with-feedback on permission prompts.

## Phase 0 runbook

Recording (Haiku, all aliases pinned in `~/.claude/settings.json`):

```bash
# terminal 1
aap serve

# terminal 2, per scenario (scripted where possible)
aap run --meta scenario=<name> claude ...
```

| Scenario           | What it exercises                            | Status   |
| ------------------ | -------------------------------------------- | -------- |
| fresh-baseline     | system prompt, tool schemas, cache writes    | recorded |
| multi-turn-edits   | stack growth, cache reads, edit loops        | recorded |
| compact            | /compact summarization protocol              | recorded |
| subagent-plan-todo | Task sidechains, plan mode, system-reminders | recorded |
| rewind-resume      | transcript tree branching, resume reload     | recorded |

Extraction targets in `docs/protocol/`:

- `system-prompt.md` — full text, what varies per request kind
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
