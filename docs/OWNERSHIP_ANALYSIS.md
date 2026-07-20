# StackPilot — Ownership Analysis

_A full assessment for the incoming maintainers: what the project is, its
strengths and weaknesses, confirmed bugs, and a prioritized plan for taking it
over. Written after a first-hand read of the core, tools, and transport layers
plus a second-pass survey of the tools/transport edge cases._

Status snapshot at time of writing: `v0.1.0`, 37 commits, single author,
`main` clean. Typecheck clean, **176 tests pass**, CI green (Node 20/22).
(Section 7 below records the hardening done on branch `fix/ownership-hardening`,
which took tests to 223.)

---

## 1. What it is

**StackPilot is a lean, from-scratch coding agent CLI** — a working alternative
to Claude Code, ~7,600 lines of strict TypeScript (Node ≥20, ESM, zero
framework). It talks directly to the Anthropic Messages API over raw
`fetch` + SSE (no SDK) and reproduces Claude Code's _behavioral core_: the
streaming agent loop, ~15 tools, an append-only session tree, prompt caching,
and auto-compaction.

The thesis (README + `docs/PLAN.md`): Claude Code is a black box, so the author
reverse-engineered its wire behavior by recording his _own_ sessions through a
proxy (`ai-agent-profiler`), then rebuilt the core with **every layer exposed
and controllable** — especially the message stack and cache. It is "built from
traces, not docs," with golden fixtures in `fixtures/traces/` and protocol
findings in `docs/protocol/`.

### Architecture (clean layering, dependency-injected)

| Layer           | Path                                                                                                     | Responsibility                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `transport/`    | `transport/anthropic.ts`                                                                                 | I/O only: SSE streaming, retry with backoff+jitter, auth.                                                  |
| `session/`      | `session/store.ts`, `events.ts`                                                                          | Append-only JSONL event **tree** (`parentUuid → uuid`); rewind/branch/resume.                              |
| `core/`         | `reducer`, `cache`, `compact`, `policies`, `loop`, `subagent`, `hooks`, `prompt`, `instructions`, `cost` | The interesting layer (below).                                                                             |
| `tools/`        | `tools/*.ts`                                                                                             | 15 tools: Read/Write/Edit/Patch/Bash/Grep/Glob/WebFetch/TodoWrite/Agent/Skill + 3 search tools + ReadMore. |
| `tui/` + `cli/` | `tui/app.ts`, `cli/main.ts`                                                                              | REPL, markdown rendering, permission prompts, headless `-p` / `--json`.                                    |

The `core/` layer is where the project's value concentrates:

- **`reducer.ts`** — pure `events → active path → API messages`. Compaction
  summaries (`isCompactSummary`) restart the API-visible conversation; nothing
  is deleted from disk. Replays Claude Code transcripts bit-exact.
- **`cache.ts`** — client-side cache **fingerprint ledger**: hashes the prefix
  the way the server keys it, _predicts_ which breakpoints a stack change will
  invalidate before the request, then reconciles against the server's usage
  counters after.
- **`policies.ts`** — context policies as **pure functions** (tool-result
  paging, read deduplication, stack eviction), each returning a new array so
  the on-wire prefix stays byte-stable for prompt caching.
- **`loop.ts`** — the request → tool → request cycle, fully dependency-injected
  and testable.

---

## 2. Strengths

1. **Genuinely novel core, well-executed.** The client-side cache fingerprint
   ledger (`core/cache.ts`) is something Claude Code doesn't expose. Reported
   result: 99% cached on turn 2.
2. **Cache-stability by construction.** Context policies are pure; reads are
   deduplicated at execution time (before storage) so the wire prefix never
   mutates. This is the correct design for prompt caching and it is enforced,
   not just hoped for.
3. **Event-sourced session tree with a pure reducer.** Deterministic replay is
   a real debugging asset; compaction is append-only.
4. **Tool-result paging over truncation.** Long outputs are stored in full
   locally and sliced on the wire with a `ReadMore` expand tool — information
   isn't lost the way Claude Code loses it.
5. **Solid engineering hygiene.** Typecheck clean, 176 tests pass, CI matrix
   (Node 20/22) runs typecheck + lint + prettier + tests; husky/lint-staged
   pre-commit; MIT licensed; packaged as a global npm bin. Comments explain
   _why_, not _what_.
6. **Honesty about its own debt.** `docs/KNOWN_ISSUES.md` documents warts; the
   changelog cross-validates cost figures against an independent proxy
   ($0.0170 vs $0.017).

---

## 3. Weaknesses

1. **Single author, early stage** (v0.1.0, 37 commits). Bus factor of one; all
   context is being inherited now.
2. **`unknown`-typed content blocks with pervasive casts** across
   reducer/loop/subagent/cache/compact/policies. `docs/KNOWN_ISSUES.md` already
   prescribes the fix (a discriminated union). Highest-leverage safety refactor.
3. **Uneven test coverage.** Core is well-tested, but `prompt.ts`, `policies.ts`
   (pure — trivially testable), `instructions.ts`, `hooks.ts`, `subagent.ts`,
   `transport/anthropic.ts` (SSE/retry), `shell.ts`, `patch.ts`, `markdown.ts`,
   and the TUI shell have **no tests**.
4. **Code duplication** — `toolUses`, usage `accumulate`, `absPath`, the
   `!`-shell handler, and `sha` are each duplicated across two files.
5. **Subagent doesn't share all context policies or the cache ledger** and
   rebuilds its message array from scratch; long subagent tool outputs
   accumulate.
6. **Provider lock-in.** Anthropic only, behind a thin transport but with no
   provider abstraction (a stated non-goal for v1, but a strategic limit).

---

## 4. Bugs & risks (confirmed)

Ordered roughly by severity. File:line references are to the current tree.

### Correctness

1. **Patch tool can silently corrupt files** — `tools/patch.ts:79,89,104`.
   Two mechanisms: (a) context/deletion checks are _skipped_ once
   `srcPos >= out.length`, so hunks claiming context past EOF are silently
   accepted; (b) the splice uses the `@@`-header's `srcLen` rather than the
   number of lines actually consumed, so a malformed/hand-edited diff can remove
   the wrong line count. **Zero tests.** Worst failure mode in a coding agent.
2. **Extended-thinking blocks are flattened to text** —
   `transport/anthropic.ts:173-187`. The stream assembler maps every
   non-`tool_use` block to `{type:"text"}`, dropping `thinking` /
   `redacted_thinking` type and `signature`. Since `thinkingBudgetTokens` is
   wired in (`anthropic.ts:99`), enabling thinking and echoing the turn back can
   fail signature validation. Real bug in a shipped feature.
3. **Mid-stream retry duplicates output** — `transport/anthropic.ts:206-233`.
   `isRetryable` returns true for the mid-stream `"stream error"` throw and
   JSON-parse throws, but `onText` deltas were already emitted before the
   failure. A retry replays the whole turn, duplicating streamed text.
   Retryability needs to separate "failed before any bytes streamed" from
   "failed mid-stream." Also ignores `Retry-After` on 429s.
4. **Unguarded `JSON.parse` in the SSE hot path** —
   `transport/anthropic.ts:120` and `:181`. One malformed `data:` line, or a
   truncated `input_json_delta`, throws and aborts the entire turn instead of
   degrading gracefully.
5. **`markLastBlock` silently loses the moving cache breakpoint** —
   `core/cache.ts:86`. If the last message's content isn't an array, marking is
   skipped and a breakpoint is quietly lost. Low impact; needs a test.
6. **`memory.ts` stores `branch` and `cwd` as always-empty** —
   `tools/memory.ts:78-79`. Declared `const … = ""` and never populated;
   `branch` is dead, `cwd` only survives via a fallback param.

### Robustness / error handling

7. **`executeTool` only catches `ToolInputError` and rethrows everything else**
   — `tools/index.ts:138`. So unguarded `writeFileSync` in Write
   (`fs.ts:88`) and Patch (`patch.ts:161`), and `res.json()` in history
   (`history.ts:94`), turn routine failures (EACCES, ENOSPC, malformed response)
   into turn-level crashes instead of clean `{isError:true}` results.
8. **Bash orphans processes on timeout and buffers output unbounded** —
   `tools/shell.ts:41,45`. `child.kill` hits only the `bash -c` process, not its
   process group, so grandchildren survive SIGKILL. Output accumulates in memory
   (`out += …`); the `MAX_OUTPUT` cap only applies at close, so `cat /dev/urandom`
   can OOM the process.
9. **Read offset/limit unvalidated** — `tools/fs.ts:34,53`. `offset=0` →
   `slice(-1)` returns wrong output; negative values aren't rejected.
10. **`history.ts` `res.json()` unguarded and uncast-validated** —
    `tools/history.ts:94`. Malformed/non-array responses throw or crash
    `formatHits`.
11. **No graceful TUI shutdown on SIGINT mid-turn** — readline may be left in
    raw mode (documented in KNOWN_ISSUES).

### Security (expected for a local dev tool — but own it consciously)

12. **WebFetch SSRF** — `tools/webfetch.ts:38,66`. `runPermitless: true`,
    follows redirects, only checks the scheme is `http(s)://`. No block on
    loopback / link-local / RFC1918 hosts, so the model can reach cloud metadata
    (`169.254.169.254`) or internal services — and the user never sees it,
    because it bypasses the permission gate.
13. **No path containment** — `util/path.ts:3`, used by `fs.ts:33,80,112` and
    `patch.ts:137`. `absPath` accepts absolute paths and `../` traversal with no
    restriction to cwd/project root. Read/Write/Edit/Patch can touch anything the
    process user can. **Read is `runPermitless`**, so unrestricted reads of any
    absolute path (`/etc/passwd`, `~/.ssh/…`) happen without a prompt.
14. **Bash runs `bash -c <command>` with no sandbox** — `tools/shell.ts:35`.
    Gated by permission prompt (good), but `--yolo` disables all prompts.

### Semantic footguns

15. **`TodoWrite` flagged `readOnly: true` while mutating state** —
    `tools/todo.ts`. The flag really means "bypass permission." Rename to
    `bypassPermission`.
16. **`AgentState` circular reference** is init-order-dependent — works only
    because of `main.ts` ordering (KNOWN_ISSUES).

### Clean (verified, no action needed)

- `search.ts` — ripgrep via `execFile` (no shell, no injection); dependency-free
  glob walk with depth/count caps.
- `memory.ts` — parameterized SQL throughout with a LIKE fallback when FTS
  `MATCH` chokes on special chars.
- `skill.ts`, `todo.ts`, `readmore.ts`, `agent.ts` — validated inputs, fixed
  paths, clean.

---

## 5. Prioritized plan for taking ownership

Ranked by value / effort now that the whole tree has been read.

1. **`patch.ts` — write tests, fix the EOF-skip and header-count-trust bugs.**
   Silent file corruption is the worst failure mode. Isolated and testable.
2. **Discriminated `ContentBlock` union** — kills the `unknown` casts across 6
   files; spec already in KNOWN_ISSUES.
3. **Transport hardening** — guard the SSE `JSON.parse` calls; fix retry to not
   replay mid-stream; preserve thinking blocks. (The thinking bug bites the
   moment someone turns on `--think`.)
4. **`executeTool` — catch all errors → `{isError:true}`** so one EACCES doesn't
   crash a turn. Small change, broad benefit.
5. **WebFetch SSRF guard + opt-in path confinement** (workspace root) for file
   tools; consider gating WebFetch behind permission.
6. **Bash: process-group kill + streaming output cap.**
7. **Test the remaining pure modules** (`policies.ts`, `prompt.ts`), de-dup the
   shared helpers, fix `memory.ts` branch/cwd.
8. **Strategic:** minimal/lazy tool loading (the marquee cache win in
   `docs/OPTIMIZATION_IDEAS.md`, ~30% cache-write savings); publish the A/B
   harness results (policy on/off via `aap compare`) — evidence is the project's
   whole pitch. If multi-provider matters, widen the `transport/` seam to an
   interface now while it's small.

---

## 6. Net assessment

A genuinely interesting, well-architected project with a clear thesis and a
clean core — but early, single-author, and carrying a handful of real
correctness bugs concentrated in `patch.ts` and the transport layer. Nothing
here is a dead end; the bones are good, and the known-issues honesty means the
debt is visible rather than hidden. The fastest way to make it safe to run on
real repos is items 1–4 above.

---

## 7. Work completed on branch `fix/ownership-hardening`

The first pass of hardening is done. Test count went 176 → 223 (+47).

| #   | Item                                | What changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Patch corruption**                | `patch.ts` now validates context/deletions past EOF, cross-checks the header `srcLen` against the parsed body, range-checks hunk start, and refuses malformed diffs instead of splicing by a trusted count. Bare empty lines are no longer mis-consumed as context. **New:** `patch.test.ts` (10 tests, incl. every corruption path).                                                                                                                                         |
| 2   | **Transport hardening**             | SSE `JSON.parse` is guarded (a malformed frame is skipped, not fatal); truncated tool-input JSON degrades to `{__malformed_json}` instead of aborting the turn; `thinking` / `redacted_thinking` blocks are preserved with signature (new union members in `types.ts`); mid-stream failures after text was emitted are wrapped in `MidStreamError` and made non-retryable (no duplicate output); `Retry-After` is now honored on 429/503. **New:** transport tests for these. |
| 3   | **executeTool error containment**   | `index.ts` now converts _any_ thrown error (not just `ToolInputError`) into `{isError:true}`, so an EACCES/ENOSPC or malformed upstream response can't crash the turn or orphan a `tool_use` without its result. **New:** containment tests.                                                                                                                                                                                                                                  |
| 4   | **WebFetch SSRF + Read validation** | `webfetch.ts` blocks loopback/link-local/RFC1918 hosts, resolves DNS to catch hostnames pointing inward, and follows redirects **manually** so every hop is re-validated. Also fixed two latent bugs (timeout / body-read paths weren't setting `isError`). `fs.ts` Read rejects `offset < 1` / non-positive `limit`. **New:** `webfetch.test.ts`, Read-validation tests.                                                                                                     |
| 5   | **Bash process handling**           | Child spawned `detached` and killed by process group on timeout (no orphaned grandchildren); output capped _during_ streaming at 2× `MAX_OUTPUT` so a runaway command can't OOM the process. **New:** `shell.test.ts` (6 tests).                                                                                                                                                                                                                                              |

Note: the discriminated `ContentBlock` union that `KNOWN_ISSUES.md` prescribed
already existed in `src/types.ts` (done before this branch); this branch
extended it with the thinking-block variants.

### Still open (next PRs)

- Opt-in path confinement (workspace root) for file/patch tools; consider
  gating WebFetch behind the permission prompt rather than permitless.
- Test the remaining pure modules (`policies.ts`, `prompt.ts`); de-dup the
  shared helpers (`toolUses`, `accumulate`, `absPath`, `sha`, `!`-handler);
  fix `memory.ts` always-empty `branch`/`cwd`.
- Graceful TUI shutdown on SIGINT mid-turn; rename `readOnly` →
  `bypassPermission`; thread `cwd` through `TurnDeps`.
- Strategic: minimal/lazy tool loading; publish A/B harness results.
