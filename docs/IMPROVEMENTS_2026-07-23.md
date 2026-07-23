# StackPilot Improvement Recommendations

**Date:** 2026-07-23
**Basis:** Behavioral eval of session `8a61f257` (CLT-348 multi-repo debug) vs the
Claude Code session `f4c0c1ef` on a near-identical task. See
[EVAL_CLT-348_2026-07-23.md](EVAL_CLT-348_2026-07-23.md).

The eval surfaced four behavioral gaps. Each maps to a concrete change in the
codebase, not a prompt tweak alone. Ordered by ROI.

---

## 1. Parallel tool execution (highest ROI)

**Observation.** The StackPilot session ran **fully sequentially** — 94 tool
calls, one at a time. The Claude Code peer fanned out (parallel reads/greps +
sub-agents) and covered a broader brief. On multi-file / multi-repo work this
is a structural ceiling, not a tuning issue.

**Root cause in code.** `src/core/loop.ts:220-221`:

```ts
for (const use of uses) {
  results.push(await dispatchTool(deps, use, stats)); // strictly serial
}
```

When the model emits multiple `tool_use` blocks in one turn, they execute
serially even when independent.

**Recommendation.**

- Run **read-only** tools (Read, Grep, Glob, ReadMore) from the same assistant
  turn concurrently via `Promise.all`, preserving result order when appending
  `tool_result` blocks (order matters for the tree invariant at 224-238).
- Keep **mutating** tools (Edit, Write, patch, shell-with-side-effects)
  serial, or gate concurrency by a per-tool `parallelSafe` flag on the registry.
- Preserve the existing interrupt-backfill invariant (every `tool_use` gets a
  `tool_result` sibling) — with `Promise.allSettled`, backfill the rejected
  slots instead of the current try/catch sweep.

**Expected impact.** Large wall-clock reduction on exploration-heavy phases;
this session's 43 min was dominated by serial round-trips.

---

## 2. Reproduction-first / evidence-before-edit guidance

**Observation.** ~30 of the first ~40 steps were static grep-theorizing about
export-barrel resolution — including greps on `export *` barrels, which
_structurally cannot_ reveal re-exported names (the agent realized this only at
step 27). The technique that actually solved it (round-trip the real API
payload through the built zod schema) was available from step 1. The agent also
made one speculative enum edit _before_ confirming the hypothesis, then found it
redundant.

**Recommendation (system prompt, `src/core/prompt.ts` / `instructions.ts`).**
Add a debugging heuristic block:

- When the symptom is "data not appearing / not rendering" **and** a live
  backend or DB is reachable, **reproduce the real payload and validate it
  against the consuming schema before extended static analysis.**
- **Do not edit source to test a hypothesis** — confirm with a read/query/probe
  first. Speculative edits cost a cache re-write and risk false positives.
- Note the `export *` grep foot-gun: barrel re-exports are invisible to
  name-grep; verify via the built artifact or a resolution probe.

**Expected impact.** Could have reached the same fix in roughly half the steps.

---

## 3. Cold-cache regeneration mitigation

**Observation.** The profiler flagged one cold-cache regeneration that re-billed
**108,895 tokens** after a ~10 min idle gap — the single largest waste in either
session. StackPilot already _detects_ this (`src/core/cache.ts:252` notes
re-writes on stable prefixes) but does not _mitigate_ it.

**Recommendation.**

- Implement the **cache pre-warming** idea already in
  [OPTIMIZATION_IDEAS.md](OPTIMIZATION_IDEAS.md) (#2), but trigger it on
  **idle-timer** rather than only at session start: when the stack has been
  idle approaching the provider TTL (~5 min for the default breakpoint), fire a
  minimal no-op refresh to keep the prefix warm before the next real turn pays
  the full re-write.
- Surface the projected re-write cost in the cost meter when an idle-expiry is
  imminent, so the user can decide.
- Make the idle threshold configurable in `config.toml`.

**Expected impact.** Directly recovers the ~100k-token class of waste on
resumed-after-idle sessions.

---

## 4. Sub-agent fan-out for multi-target investigation

**Observation.** StackPilot has a subagent tool (`src/tools/agent.ts`,
`src/core/subagent.ts`) but did **not** use it; the Claude Code peer dispatched
parallel exploration agents across the three frontends. For a 4-repo problem,
fanning out exploration would have parallelized discovery and kept the main
context smaller (findings return summarized).

**Recommendation.**

- Add prompt guidance: for investigations spanning **≥3 independent
  files/dirs/repos**, prefer dispatching parallel Explore/general sub-agents
  over sequential main-loop reads.
- Ensure the subagent path benefits from #1 (parallel dispatch) so multiple
  agents actually run concurrently.
- Consider a lightweight "survey" preset that fans out read-only agents and
  returns a merged map — the profiler shows this is where the peer spent its
  parallelism budget.

**Expected impact.** Faster, broader coverage on multi-concern tasks; smaller
main-loop context growth (this session grew ~2 → ~157k input tokens).

---

## Summary table

| #   | Change                                    | Where                                | Type        | ROI    |
| --- | ----------------------------------------- | ------------------------------------ | ----------- | ------ |
| 1   | Parallel read-only tool dispatch          | `core/loop.ts:220` + registry flag   | Code        | High   |
| 2   | Reproduction-first + no speculative edits | `core/prompt.ts` / `instructions.ts` | Prompt      | High   |
| 3   | Idle-triggered cache pre-warm             | `core/cache.ts` + config             | Code        | Medium |
| 4   | Sub-agent fan-out guidance                | prompt + depends on #1               | Prompt+Code | Medium |

---

## Cheaper vs quicker — what each change actually moves

Cost and latency are **different levers**. A change can make a session faster
without making it cheaper (parallelism), or cheaper without making it faster
(cache warming), or both (doing fewer steps). Cost here = tokens billed
(output + cache write/read); speed = wall-clock to result.

| #   | Change                                    |      Cheaper?       |    Quicker?    | Why                                                                                                                                                                                                        |
| --- | ----------------------------------------- | :-----------------: | :------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Parallel read-only tool dispatch          |     ➖ neutral      | ✅ **primary** | Same tokens billed, but N independent reads/greps resolve in one round-trip window instead of N serial ones. Pure wall-clock win.                                                                          |
| 2   | Reproduction-first + no speculative edits |   ✅ **primary**    |  ✅ secondary  | Fewer steps = fewer requests = less output + cache-read billed, and each avoided step is also avoided latency. Kills the ~30-step grep detour and the redundant enum edit (which forced a cache re-write). |
| 3   | Idle-triggered cache pre-warm             |   ✅ **primary**    | ➖ slight cost | Recovers the ~108k-token re-write after idle (large $ saving). Adds one tiny no-op request, so marginally _more_ wall-clock, not less.                                                                     |
| 4   | Sub-agent fan-out                         | ➖ roughly neutral* | ✅ **primary** | Parallel discovery collapses multi-target exploration wall-clock; keeps main context smaller. *Total tokens can rise slightly (agent overhead) but main-loop context grows less, offsetting it.            |

**Net read:**

- **Want cheaper sessions →** prioritize **#2** (fewer steps) and **#3**
  (kill idle re-writes). These attack tokens billed directly.
- **Want quicker results →** prioritize **#1** (parallel dispatch) and **#4**
  (fan-out). These attack wall-clock without changing token volume much.
- **#2 is the only change that clearly does both**, because a step not taken is
  both a token not billed and a round-trip not waited on. Highest overall ROI.

Concrete anchors from this session: #2 targets the ~30-step static-analysis
detour and the 1 redundant edit; #3 targets the single 108,895-token idle
regeneration; #1 and #4 target the fully-serial 94-call / 43-min execution.

---

## Plan of action

Sequenced so that cost wins land first (lowest effort, no dependencies), then
the latency wins, then the change that depends on #1.

### Phase 0 — Prompt-only, ship immediately (cheaper, no code risk)

**Change #2.** Add the debugging heuristic to `src/core/prompt.ts` /
`instructions.ts`: reproduction-first when a live backend/DB is reachable;
no source edits to test a hypothesis; the `export *` grep foot-gun note.

- **Effort:** low (prompt text + a prompt test).
- **Validation:** re-run a CLT-348-style task through the profiler; expect
  fewer requests and lower cost to first correct diagnosis.
- **Risk:** low — reversible, no loop changes.

### Phase 1 — Idle cache pre-warm (cheaper)

**Change #3.** Idle-timer no-op refresh before TTL expiry; surface projected
re-write cost in the meter; configurable threshold in `config.toml`.

- **Effort:** medium (idle timer + reuse existing detection in `cache.ts:252`).
- **Validation:** simulate a >5-min idle mid-session; confirm the next real
  turn reads from cache instead of re-billing ~100k tokens.
- **Risk:** low-medium — one extra request per idle window; gate behind config,
  default conservative.

### Phase 2 — Parallel read-only tool dispatch (quicker)

**Change #1.** Concurrent `Promise.all` for read-only tools in
`loop.ts:220-221`; `parallelSafe` flag on the registry; mutating tools stay
serial; preserve `tool_result` ordering and the interrupt-backfill invariant
(switch the try/catch sweep to `allSettled` + per-slot backfill).

- **Effort:** medium-high (concurrency + invariant preservation + tests).
- **Validation:** golden-trace test with a multi-read turn; assert identical
  tree output to the serial path and reduced wall-clock.
- **Risk:** medium — touches the core loop invariant; needs strong test cover.

### Phase 3 — Sub-agent fan-out (quicker; depends on Phase 2)

**Change #4.** Prompt guidance to fan out for ≥3 independent targets; optional
read-only "survey" preset. Only worthwhile once Phase 2 lets multiple agents
run concurrently.

- **Effort:** low prompt + reuse of `tools/agent.ts` / `core/subagent.ts`.
- **Validation:** multi-repo task; confirm parallel agents dispatch and main
  context grows less than the serial baseline (~2 → ~157k this session).
- **Risk:** low behaviorally; inherits Phase 2's concurrency correctness.

**Ordering rationale:** Phase 0 is free and cost-positive today. Phase 1 is
isolated and cost-positive. Phase 2 carries the loop-invariant risk so it goes
after the safe wins and gets the most test attention. Phase 3 is gated on Phase 2. After each phase, re-run the same CLT-348-class task through the
ai-agent-profiler and compare cost + wall-clock against this session's baseline
(94 calls / 43 min / $10.10).

---

**What NOT to change:** the empirical-verification instinct, the diagnostic
cleanup discipline (temp diagnostics fully reverted + `git diff --stat`
verified), the self-correction behavior, and the "confirm the full blast radius"
thoroughness — all were strengths and should be preserved. #2's guidance should
_accelerate_ the empirical instinct, not replace it.
