# StackPilot — Ownership Analysis

_A full assessment for the incoming maintainers: what the project is, its
strengths and weaknesses, confirmed bugs, and a prioritized plan for taking it
over. Written after a first-hand read of the core, tools, and transport layers
plus a second-pass survey of the tools/transport edge cases._

Status snapshot at time of writing: `v0.1.0`, 37 commits, single author,
`main` clean. Typecheck clean, **176 tests pass**, CI green (Node 20/22).
**Section 7 is a living issue tracker** — every issue below is a checkbox there;
tick it as work lands. First hardening pass (`fix/ownership-hardening`) took
tests to 223.

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

## 7. Issue tracker

Living checklist of every issue raised in this analysis and its status. Update
the box as work lands — this is the source of truth for "what's left," so keep
it current rather than starting a fresh list.

**Legend:** `[x]` done · `[ ]` pending · `[~]` in progress · `[>]` delayed /
deferred · `[-]` won't do (reason given). Test count so far: 176 → 295 (+119)
across the hardening, Bedrock, and TUI/polish branches.
(A `vitest.config.ts` was also added to scope test discovery to `src/`, so a
prior `npm run build` no longer makes vitest double-run compiled `dist/` copies.)

### Correctness & robustness

- [x] **Patch tool can silently corrupt files** (`patch.ts`) — validate
      context/deletions past EOF, cross-check header `srcLen` against the parsed
      body, range-check hunk start, refuse malformed diffs; stop mis-consuming
      bare empty lines as context. _New `patch.test.ts` (10 tests)._
      `fix/ownership-hardening`
- [x] **Extended-thinking blocks flattened to text** (`anthropic.ts`) —
      preserve `thinking` / `redacted_thinking` with signature (new union
      members in `types.ts`). `fix/ownership-hardening`
- [x] **Mid-stream retry duplicates output** (`anthropic.ts`) — wrap post-emit
      failures in `MidStreamError`, make non-retryable; honor `Retry-After` on
      429/503. `fix/ownership-hardening`
- [x] **Unguarded `JSON.parse` in SSE hot path** (`anthropic.ts`) — skip a
      malformed frame instead of aborting the turn; truncated tool-input JSON
      degrades to `{__malformed_json}`. `fix/ownership-hardening`
- [x] **`executeTool` only caught `ToolInputError`** (`index.ts`) — convert
      _any_ thrown error to `{isError:true}` so a tool failure can't crash the
      turn or orphan a `tool_use`. `fix/ownership-hardening`
- [x] **Bash orphans processes / unbounded output** (`shell.ts`) — spawn
      `detached`, kill the process group on timeout, cap output during
      streaming. _New `shell.test.ts` (6 tests)._ `fix/ownership-hardening`
- [x] **Read offset/limit unvalidated** (`fs.ts`) — reject `offset < 1` /
      non-positive `limit`. `fix/ownership-hardening`
- [x] **Discriminated `ContentBlock` union** (`types.ts`) — already existed
      before this branch (KNOWN_ISSUES prescribed it); extended here with the
      thinking-block variants.
- [x] **`markLastBlock` silently loses the moving cache breakpoint**
      (`cache.ts`) — place the moving breakpoint on the last _non-empty_
      message so an empty trailing turn can't drop it (would cost a full
      re-read). _New cache test._ `fix/ownership-hardening`
- [x] **`memory.ts` stores `branch`/`cwd` as always-empty** (`memory.ts`) —
      `extractMeta` now takes the session cwd and derives the git branch via
      a best-effort `git rev-parse` (empty when not a repo).
      `fix/ownership-hardening`
- [x] **`history.ts` `res.json()` unguarded/unvalidated** (`history.ts`) —
      guard the parse, reject non-array/non-JSON bodies, and filter entries
      through an `isSearchHit` type guard before `formatHits`. _New tests._
      `fix/ownership-hardening`

### Security

- [x] **WebFetch SSRF** (`webfetch.ts`) — block loopback/link-local/RFC1918,
      resolve DNS to catch inward-pointing names, follow redirects manually to
      re-validate each hop. _New `webfetch.test.ts`._ `fix/ownership-hardening`
- [x] **No path containment** (`util/path.ts`, fs/patch/search tools) —
      added opt-in `confineToWorkspace` config: when on, file tools
      (Read/Write/Edit/Patch/Grep/Glob) refuse any path outside the workspace
      root (git root, else cwd), blocking absolute-path reads and `../`
      escapes. Off by default. _New `path.test.ts` + fs integration tests._
      `fix/ownership-hardening`
- [ ] **Consider gating WebFetch behind the permission prompt** rather than
      leaving it `runPermitless` (defense-in-depth beyond the SSRF guard).
- [>] **Bash has no sandbox** (`shell.ts`) — deferred; it's a Bash tool by
  design, gated by the permission prompt. Revisit only if a sandbox mode is
  added.

### Semantic footguns

- [x] **Tool permission flag** — resolved: the flag is `runPermitless` (means
      "bypass the prompt"), not a misleading `readOnly`. Fixed the stale
      `/config` hint ("read-only"/"mutating" → "no prompt"/"asks permission").
      `feat/tui-and-polish`
- [x] **`AgentState` circular reference** — resolved: `createAgentTool` takes a
      lazy `getRegistry()` closure over the `const registry`, not a post-hoc
      assignment. No init-order fragility.
- [x] **No graceful TUI shutdown on SIGINT mid-turn** (`cli/main.ts`) — the
      signal handler now restores the terminal (raw mode off, cursor shown)
      before exit. `feat/tui-and-polish`

### TUI

- [x] **Streaming markdown was dead code** (`tui/app.ts` / `markdown.ts`) —
      `onText` now feeds `MarkdownRenderer.push()`; headings/bold/lists/fenced
      code render during streaming. _New `markdown.test.ts` (9)._
      `feat/tui-and-polish`
- [x] **Divergent render paths** — `app.ts` + headless `main.ts` now route tool
      display through `render.ts` `toolStartLine`/`toolEndLine` (clean
      `⏺ Bash(npm test)` not raw JSON); removed the dead `banner()`.
      `feat/tui-and-polish`
- [x] **Misleading Edit/Patch diff branch** (`render.ts`) — those tools return
      status strings, not diffs; show a success line like Write. Removed unused
      `renderDiff`/`diffLine`; README "diff colorization" claim dropped.
      `feat/tui-and-polish`

### Test coverage & cleanup

- [x] **Test the remaining pure modules** — `policies.ts`/`prompt.ts` covered
      during hardening; `instructions.ts` (7) + `hooks.ts` (10) +
      `markdown.ts` (9) added on `feat/tui-and-polish`.
- [x] **De-duplicate shared helpers** — `toolUses`/`accumulateUsage` unified
      into `util/message.ts` (imported by loop.ts + subagent.ts); `absPath` in
      `util/path.ts`; transport helpers centralized in `stream.ts`.
- [ ] **Thread `cwd` through `TurnDeps`** instead of `process.cwd()` in loop
      and subagent (portability/testability).
- [ ] **Give the subagent the same context policies** (and consider its own
      cache ledger).

### Strategic

- [ ] **Minimal/lazy tool loading** — marquee cache win in
      `docs/OPTIMIZATION_IDEAS.md` (~30% cache-write savings).
- [ ] **Publish A/B harness results** (policy on/off via `aap compare`).
- [x] **Widen `transport/` to a provider interface** — done: the streaming core
      lives in `stream.ts`, `streamWithRetry` routes by provider, and
      **Amazon Bedrock** shipped as a second provider (event-stream + SigV4).
