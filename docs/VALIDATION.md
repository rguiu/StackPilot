# StackPilot Validation Plan

How to validate StackPilot against Claude Code, evaluate improvements
in all areas (tools, usage, cost, tokens, cache maximization), and
measure the impact of optimizations — step by step, portable across
machines.

## Prerequisites (every machine)

### Install ai-agent-profiler

```bash
git clone https://github.com/rguiu/ai-agent-profiler /tmp/aap
cd /tmp/aap
npm install
npm run build
npm link
```

Verify:

```bash
aap help    # should print available commands
```

### Install StackPilot

```bash
cd /path/to/stackpilot
npm install
npm run build
npm link
```

Verify:

```bash
stackpilot --version    # should print version + build commit
```

### Install Claude Code (for baseline comparison)

One-time: install Claude Code however you normally do (npm, brew, etc.)

Verify:

```bash
claude --version
```

### Configure API keys

```bash
# Anthropic — required for both Claude Code and StackPilot
export ANTHROPIC_API_KEY=sk-ant-...

# Or if using Bedrock:
export CLAUDE_CODE_USE_BEDROCK=1
export AWS_REGION=eu-west-1
export ANTHROPIC_MODEL=haiku
export ANTHROPIC_DEFAULT_HAIKU_MODEL=eu.anthropic.claude-haiku-4-5-20251001
```

---

## 1. CORRECTNESS VALIDATION

### 1.1 Unit test suite

Goal: ensure the existing tests pass before any evaluation.

```bash
cd /path/to/stackpilot
npm test

# Expect: all 90+ tests green
# If failures: check KNOWN_ISSUES.md and OWNERSHIP_ANALYSIS.md for known bugs
```

### 1.2 Deterministic replay test (golden fixture)

Goal: verify bit-exact replay of Claude Code transcripts.

```bash
cd /path/to/stackpilot
npm test -- reducer.test.ts

# Expect: "replaying the real Claude Code rewind transcript yields
# exactly 51 total / 25 active / 6 abandoned / 2 leaves / 2 branch points"
```

If this test fails, StackPilot's session tree model has diverged from Claude
Code's wire format — stop and fix before any other evaluation.

### 1.3 Wire-protocol conformance

Goal: verify StackPilot sends requests shaped like Claude Code.

**Step 1 — Start the proxy:**

```bash
# Terminal 1
aap serve
# Output: Listening on http://127.0.0.1:8080
```

**Step 2 — Record a Claude Code session:**

```bash
# Terminal 2
AAP_SESSION_ID=claude-wire-check aap run claude -p --dangerously-skip-permissions \
  "What does src/core/loop.ts do in /path/to/stackpilot? Read the file and explain the turn loop."
```

**Step 3 — Record the same prompt with StackPilot:**

```bash
AAP_SESSION_ID=sp-wire-check aap run stackpilot -p --yolo \
  "What does src/core/loop.ts do? Read the file and explain the turn loop."
```

Note: StackPilot uses `-p --yolo` for headless yes-to-all, matching Claude
Code's `-p --dangerously-skip-permissions`.

**Step 4 — Compare the wire shapes:**

```bash
aap compare claude-wire-check sp-wire-check
```

Look for:

- System prompt block count: should be ~4-5 blocks in both
- Tool schemas: StackPilot should have 14 tools vs Claude Code's 29
- `cache_control` breakpoints: StackPilot places 3-4 (static×2, anchor, moving);
  Claude Code places 2 (static×2, moving)
- Tool-use/tool-result pairing: identical pattern

**Expected differences (acceptable):**

- StackPilot has fewer tools (14 vs 29) — by design
- System prompt content differs (StackPilot's own text vs Claude Code's)
- StackPilot has the anchor breakpoint (improvement over Claude Code)

**Unexpected differences (bugs):**

- Missing `tool_use_id` / `tool_result` pairing
- Different content block structure (text vs tool_use vs tool_result ordering)
- Missing `cache_control` on system blocks

---

## 2. BENCHMARK SETUP

### 2.1 Add StackPilot as a benchmark agent

The benchmark runner (`ai-agent-profiler/benchmarks/run.sh`) currently only
supports `opencode` and `claude`. Add StackPilot support.

**Step 1 — Find the run script:**

```bash
ls /tmp/aap/benchmarks/run.sh
# Or wherever you cloned ai-agent-profiler
```

**Step 2 — Edit the agent mapping. Find this block (around line 115):**

```bash
case "$AGENT" in
  opencode) INVOKE="run --auto" ;;
  claude)   INVOKE="-p --dangerously-skip-permissions" ;;
  *) echo "unknown agent: $AGENT (use opencode or claude)" >&2; exit 1 ;;
esac
```

**Add StackPilot:**

```bash
case "$AGENT" in
  opencode) INVOKE="run --auto" ;;
  claude)   INVOKE="-p --dangerously-skip-permissions" ;;
  stackpilot) INVOKE="-p --yolo" ;;
  *) echo "unknown agent: $AGENT (use opencode, claude, or stackpilot)" >&2; exit 1 ;;
esac
```

Also update the error message at the top (around line 7) to include `stackpilot`.

### 2.2 Run the baseline benchmark

Goal: get Claude Code numbers as the reference.

```bash
# Terminal 1 — start the proxy
cd /tmp/aap
aap serve

# Terminal 2 — run baseline
cd /tmp/aap
./benchmarks/run.sh claude --fixture iterative-fix-plus --tag baseline-claude
```

**This will:**

1. Copy the `iterative-fix-plus` fixture to a scratch directory
2. Run each task from `TASKS` with Claude Code
3. Verify the fix tasks (run `npm test` after agent finishes)
4. Tag sessions with `verify=pass|fail`
5. Generate a report at `benchmarks/runs/baseline-claude/report.md`

**Expected output:**

```
[1/4] explain   agent=claude  tag=baseline-claude  ...
>>> verify [explain]: (no verify — read-only)
[2/4] locate    agent=claude  tag=baseline-claude  ...
>>> verify [locate]: (no verify — read-only)
[3/4] fix-bug   agent=claude  tag=baseline-claude  ...
>>> verify [fix-bug]: npm test
    verify=pass
[4/4] add-feature  agent=claude  tag=baseline-claude  ...
>>> verify [add-feature]: npm test
    verify=pass
```

**If verify=fail:** Check `benchmarks/runs/baseline-claude/verify/<task>.log`
for details. Claude Code may need different fixture sizes or models. The
`iterative-fix-plus` fixture has 7 modules with planted bugs — Claude Code
with Haiku should pass all verify steps.

### 2.3 Run the equivalent StackPilot benchmark

```bash
# Same terminal 2, same proxy running
cd /tmp/aap
./benchmarks/run.sh stackpilot --fixture iterative-fix-plus --tag baseline-stackpilot
```

**Expected output:** Same 4 tasks. Focus on `verify=pass|fail` for `fix-bug`
and `add-feature`.

### 2.4 Compare baseline results

```bash
cd /tmp/aap
aap compare --run baseline-claude --run baseline-stackpilot
```

**Output columns:**

| Metric        | Meaning                           |
| ------------- | --------------------------------- |
| Requests      | Total API calls                   |
| Input tokens  | Fresh (uncached) input tokens     |
| Cached tokens | Cache-read tokens (billed at 10%) |
| Output tokens | Model response tokens             |
| Cost          | Total USD                         |
| Tool calls    | Total tool invocations            |
| Wall time     | Clock time across all requests    |

**What to look for:**

1. **Cost:** StackPilot should be ≤ Claude Code on equivalent tasks (fewer
   tools = smaller cache prefix = cheaper cache writes)
2. **Cache hit %:** StackPilot's ledger should show 90%+ on turns 2+
3. **Verify=pass rate:** Should match Claude Code. If StackPilot fails tasks
   Claude Code passes, that's the most important signal — everything else is
   secondary.

### 2.5 Generate aggregate baselines

```bash
cd /tmp/aap
node benchmarks/baselines.mjs
# Writes benchmarks/BASELINES.md with per-agent averages
```

---

## 3. CACHE VALIDATION

### 3.1 Unit-level cache tests

```bash
cd /path/to/stackpilot
npm test -- cache.test.ts

# Expect all tests green. If any fail, cache behavior is broken —
# fix before any cost comparison.
```

### 3.2 Live cache behavior verification

Goal: verify that the client-side cache ledger's predictions match the
server's actual cache behavior.

**Step 1 — Run a session through the proxy:**

```bash
# Terminal 1
aap serve

# Terminal 2
AAP_SESSION_ID=cache-live-test aap run stackpilot -p --yolo \
  "Read the file src/core/cache.ts and explain what each function does.
   Then read src/core/loop.ts and explain how it uses the cache."
```

**Step 2 — Examine the cache metrics:**

```bash
aap export cache-live-test
```

**Step 3 — Cross-check StackPilot's self-reported cache stats:**

- The session trace (in `~/.stackpilot/projects/<slug>/<uuid>.jsonl`) records
  `usage` per assistant event — verify `cache_read_input_tokens` and
  `cache_creation_input_tokens` match what `aap` parsed from the raw trace.
- StackPilot's own ledger verdicts (printed as `⚠` notes under the stats line)
  should be `hit` on turn 2+, not `unexpected-regen`.

**Step 4 — Check for unexpected regenerations:**

```bash
# If aap export shows cache_creation > 0 on turns where the prefix should
# have been stable, something broke the cache.
aap export cache-live-test --json | grep cache_creation
```

A healthy session: turn 1 writes ~8k tokens to cache, turns 2+ read from
cache with minimal writes (< 1k tokens per turn for newly appended content).

### 3.3 Cache pre-warming test (optimization candidate)

Goal: measure the cost savings of pre-establishing the cache before the first
user turn.

**Step 1 — Baseline (no pre-warming):**

```bash
AAP_SESSION_ID=no-warmup aap run stackpilot -p --yolo \
  "Write a function that computes fibonacci numbers in /tmp/fib.js"
```

**Step 2 — Record the cache metrics:**

```bash
aap export no-warmup --json | jq '{requests: .requests | length, cache_read: [.requests[].cache_read_input_tokens] | add, cache_write: [.requests[].cache_creation_input_tokens] | add}'
```

**Step 3 — If cache pre-warming is implemented (see Section 7.4), repeat:**

```bash
AAP_SESSION_ID=with-warmup aap run stackpilot -p --yolo \
  "Write a function that computes fibonacci numbers in /tmp/fib.js"
```

**Step 4 — Compare:**

```bash
aap compare no-warmup with-warmup
```

Hypothesis: cache_write on turn 1 drops from ~8k to ~0 because the prefix
was already cached by the warmup request. Net savings depend on the warmup
request cost vs the turn-1 cache-write cost.

---

## 4. TOOL USAGE EVALUATION

### 4.1 Measure tool efficiency per task

```bash
# After running the baseline benchmarks (Section 2):
cd /tmp/aap
aap compare --run baseline-claude --run baseline-stackpilot
```

**Metrics to compare per task:**

| Metric                               | What it shows                           |
| ------------------------------------ | --------------------------------------- |
| `tool_call_count`                    | Total tool invocations                  |
| `distinct_tools`                     | How many different tool types were used |
| `tool_result_tokens`                 | How much tool output entered context    |
| `repeated_file_read` recommendations | Redundant file reads                    |
| `high_amplification` recommendations | Tools producing too much output         |
| `inefficient_search` recommendations | Search→read round-trips                 |

**Interpretation:**

- Higher tool count isn't necessarily worse — it can mean the model is being
  more careful and iterative
- Lower tool count isn't necessarily better — it can mean the model is guessing
  instead of reading
- **The only real signal is `verify=pass` rate × cost.** An agent that fails
  tasks at $0.05 is worse than an agent that passes tasks at $0.10.

### 4.2 Validate Read deduplication policy

Goal: verify that repeated reads of unchanged files are flagged.

```bash
# Two reads of the same file, no edits in between
AAP_SESSION_ID=dedup-test aap run stackpilot -p --yolo \
  "Read src/core/loop.ts. Now read src/core/loop.ts again. Tell me if anything changed."
```

Check the session trace:

```bash
# The second Read should produce "[unchanged from previous read — NNNN chars]"
# instead of repeating the full file content.
aap export dedup-test --json | jq '.requests[-1].body.messages[-1].content[] | select(.type=="tool_result")'
```

### 4.3 Validate tool-result paging policy

Goal: verify that large tool outputs are truncated with a ReadMore marker.

```bash
# Read a large file that exceeds the paging threshold (default 10k chars)
AAP_SESSION_ID=paging-test aap run stackpilot -p --yolo \
  "Read the entire file benchmarks/fixtures/big-file/src/glossary.js and tell me what functions it exports."
```

Check the session trace:

```bash
aap export paging-test --json | jq '.requests[-1].body.messages[-1].content[] | select(.type=="tool_result")'
```

The Read result should contain:

```
[truncated NNNN of NNNNN chars — use ReadMore to expand]
```

And the full content should be recoverable via ReadMore.

### 4.4 Validate subagent context policies

Goal: verify that subagents apply the same paging and dedup policies as
the main agent.

**Step 1 — Run a task that spawns a subagent with large tool outputs:**

```bash
AAP_SESSION_ID=subagent-test aap run stackpilot -p --yolo \
  "Use the Agent tool with type=explore to find all .ts files in src/ and explain what each one does. Then summarize the findings."
```

**Step 2 — Check the wire trace for subagent API calls:**

```bash
aap export subagent-test --json | jq '.requests[] | select(.body.messages | length < 20)'
```

Subagent requests should have:

- Fewer messages than the main conversation (isolated context)
- Tool results truncated if they exceed the paging threshold
- No unbounded accumulation of large tool outputs

**Known issue:** Subagents currently do NOT apply context policies
(KNOWN_ISSUES.md line 58-63). If you see long tool outputs accumulating
in subagent requests, this bug is confirmed and should be fixed before
comparing subagent cost metrics.

---

## 5. COST & TOKEN VALIDATION

### 5.1 Validate the dollar cost meter

Goal: verify StackPilot's self-reported cost matches the proxy's independent
calculation.

**Step 1 — Run a multi-turn session:**

```bash
AAP_SESSION_ID=cost-check aap run stackpilot -p --yolo \
  "Edit src/core/cost.ts to add a JSDoc comment at the top of the file. Just add the comment, nothing else."
```

**Step 2 — Compare costs:**

```bash
# StackPilot's self-report (from the session trace):
# Look at the last assistant event's usage + StackPilot's stats line

# Proxy's independent calculation:
aap export cost-check --json | jq '.requests | map(.cost) | add'
```

**Step 3 — Assert within 1%:**
Both numbers should match within $0.001. If they diverge:

- Check that pricing is configured in `~/.stackpilot/config.toml`
- Check that the same `[pricing]` entries exist in `~/.aap/config.toml`
- Verify that the model returned by the API matches a pricing key

### 5.2 Validate pricing configuration

StackPilot's config (`~/.stackpilot/config.toml`):

```toml
[pricing]
[pricing."claude-haiku-4-5-20251001"]
inputPerMTok = 1.0
outputPerMTok = 5.0
cacheInputPerMTok = 0.10
cacheWritePerMTok = 1.25
```

ai-agent-profiler config (`~/.aap/config.toml` or `/tmp/aap/config.toml`):

```toml
[pricing]
[pricing."claude-haiku-4-5-20251001"]
inputPerMTok = 1.0
outputPerMTok = 5.0
cacheInputPerMTok = 0.10
cacheWritePerMTok = 1.25
```

Both must use identical rates for cost comparison to be valid.

### 5.3 Measure per-subsystem token budgets

Goal: understand where tokens are spent.

**Run the context analysis:**

```bash
aap export <session-id> --json | jq '
{
  system_tokens: .analysis.context.system_tokens_total,
  tools_tokens: .analysis.context.tools_tokens_total,
  input_tokens: .analysis.context.input_tokens_total,
  cached_tokens: .analysis.context.cached_input_tokens_total,
  output_tokens: [.requests[].output_tokens] | add,
  amplification: [.analysis.toolUsage[] | select(.result_tokens > 1000) | {name, result_tokens}]
}'
```

**Budget targets:**

| Component               | % of total input   | Action if exceeded                  |
| ----------------------- | ------------------ | ----------------------------------- |
| System prompt           | < 30%              | Trim system prompt                  |
| Tool definitions        | < 20% (with cache) | Enable progressive tools            |
| Tool results            | < 40%              | Enable paging, lower threshold      |
| User/assistant messages | > 10%              | Normal — this is the "real" context |

---

## 6. OPTIMIZATION A/B TESTING

### 6.1 General A/B protocol

For any optimization candidate, follow this protocol:

1. **Form a hypothesis:** "Enabling X will reduce Y by Z% without degrading
   verify pass rate."
2. **Choose fixtures:** At least 3 (csv-parser, task-queue, iterative-fix-plus)
   to cover different stress patterns.
3. **Run baseline (control):** The agent with the optimization OFF.
4. **Run experiment (treatment):** The agent with the optimization ON.
5. **Compare:** `aap compare --run <baseline-tag> --run <experiment-tag>`
6. **Decide:**
   - If cost decreases AND verify rate stays within 5% → adopt
   - If cost decreases but verify rate drops → document tradeoff
   - If cost increases → reject
   - If no significant difference → the optimization doesn't matter

### 6.2 Test: Progressive tool loading

**Hypothesis:** Starting with only CORE_TOOLS (Read, Grep, Glob) and loading
others lazily reduces cache-write tokens by 20-30% on sessions with 10+ turns.

**Current status:** Implemented but off by default.

**Enable it:**

```toml
# In ~/.stackpilot/config.toml
progressiveTools = true
```

**Baseline run (off):**

```bash
# Ensure progressiveTools is commented out or set to false
cd /tmp/aap
./benchmarks/run.sh stackpilot --fixture iterative-fix-plus --tag progressive-off
```

**Experiment run (on):**

```bash
# Set progressiveTools = true in config.toml
cd /tmp/aap
./benchmarks/run.sh stackpilot --fixture iterative-fix-plus --tag progressive-on
```

**Compare:**

```bash
aap compare --run progressive-off --run progressive-on
```

**Accept if:** Cache-write tokens decrease by >15% AND verify=pass rate
stays within 5% of baseline.

### 6.3 Test: Tool-result paging threshold

**Hypothesis:** Lowering the paging threshold from 10k to 5k chars saves
tokens on large tool outputs without losing information (because ReadMore
is available).

**Change threshold:**

```toml
# In ~/.stackpilot/config.toml
maxToolResultChars = 5000
```

**Baseline (default 10k):**

```bash
cd /tmp/aap
./benchmarks/run.sh stackpilot --fixture big-file --tag paging-10k
```

**Experiment (5k):**

```bash
cd /tmp/aap
./benchmarks/run.sh stackpilot --fixture big-file --tag paging-5k
```

**Compare:**

```bash
aap compare --run paging-10k --run paging-5k
```

**Accept if:** Input tokens decrease (less tool output in context) AND
verify=pass rate doesn't degrade. The model should use ReadMore when it
needs more context.

### 6.4 Test: Cheap model routing for compaction

**Hypothesis:** Running compaction through Haiku is >50% cheaper than
running it through the main model, with no degradation in summary quality.

**Configure:**

```toml
# In ~/.stackpilot/config.toml
cheapModel = "claude-haiku-4-5-20251001"
```

**Baseline (no cheap model — compaction uses main model):**

```bash
cd /tmp/aap
./benchmarks/run.sh stackpilot --fixture iterative-fix-plus --tag compact-no-cheap
```

**Experiment (cheap model for compaction):**

```bash
# Set cheapModel in config.toml
cd /tmp/aap
./benchmarks/run.sh stackpilot --fixture iterative-fix-plus --tag compact-cheap
```

**Compare:**

```bash
aap compare --run compact-no-cheap --run compact-cheap
```

**Accept if:** Compaction cost decreases AND overall verify=pass rate
doesn't degrade. The `iterative-fix-plus` fixture has multi-turn tasks
that trigger auto-compaction.

---

## 7. IMPLEMENTING OPTIMIZATIONS (when ready)

### 7.1 Prerequisite: fix known correctness bugs

Before adding any optimization, fix these bugs (from OWNERSHIP_ANALYSIS.md).
They affect metric accuracy:

1. **Patch tool can silently corrupt files** — `src/tools/patch.ts:79,89,104`
   - Fix: validate context/deletions past EOF, cross-check header `srcLen`
   - This is the worst failure mode — a verify=pass can be a false positive

2. **markLastBlock loses the moving cache breakpoint on empty messages**
   — `src/core/cache.ts:86`
   - Fix: place the moving breakpoint on the last non-empty message
   - This causes full cache re-reads, inflating cost metrics

3. **Read offset=0 returns wrong output** — `src/tools/fs.ts:34,53`
   - Fix: reject `offset < 1`, non-positive `limit`
   - This can cause the agent to read wrong content, affecting task correctness

4. **Mid-stream retry duplicates output** — `src/transport/anthropic.ts:206-233`
   - Fix: make retry non-replayable when bytes were already emitted
   - This inflates output token counts in error-prone sessions

### 7.2 Mandatory: add `stackpilot` to the benchmark runner

Edit `/tmp/aap/benchmarks/run.sh` (or wherever you cloned ai-agent-profiler).

**Find the agent mapping block (around line 115):**

```bash
case "$AGENT" in
  opencode) INVOKE="run --auto" ;;
  claude)   INVOKE="-p --dangerously-skip-permissions" ;;
  *) echo "unknown agent: $AGENT (use opencode or claude)" >&2; exit 1 ;;
esac
```

**Replace with:**

```bash
case "$AGENT" in
  opencode) INVOKE="run --auto" ;;
  claude)   INVOKE="-p --dangerously-skip-permissions" ;;
  stackpilot) INVOKE="-p --yolo" ;;
  *) echo "unknown agent: $AGENT (use opencode, claude, or stackpilot)" >&2; exit 1 ;;
esac
```

Also update the help text near the top (around line 7):

```bash
#   <agent>              opencode | claude | stackpilot
```

### 7.3 Optimization 1: Enable progressive tools by default

**File:** `src/tools/index.ts`
**Change:** Set the default for `progressiveTools` to `true`.
**Or:** Enable it via config for testing without code changes:

```toml
progressiveTools = true
```

**How it works:** Sessions start with only `CORE_TOOLS` (Read, Grep, Glob,
TodoWrite) in the schema prefix. When the model calls a deferred tool by
name, `loop.ts` activates its schema (one deliberate cache write) and retries.
Subsequent turns include the activated tool in the cached prefix.

**Cost model:** The initial prefix is ~40% smaller (3-4 tools vs 14).
Each activation costs one cache write (~6k chars × 1.25× billing for
cache writes). Net savings on a 10-turn session: 30% of cache-write costs.

**Validation:** Run Section 6.2 A/B test.

### 7.4 Optimization 2: Cache pre-warming

**File:** `src/cli/main.ts` (or new function in `src/core/cache.ts`)

**Implementation sketch:**

```typescript
// After session store is created, before the first user prompt:
async function warmCache(
  config: TransportConfig,
  system: string,
  tools: unknown[],
  stream: TurnDeps["stream"],
  signal?: AbortSignal,
): Promise<void> {
  const warmReq = applyCacheControl(system, tools, []);
  // Send the empty request — server caches the system+tools prefix
  await stream(config, warmReq, () => {}, signal);
  // The response is discarded (minimal output), but the server now has
  // the static prefix cached. Turn 1 will read from cache instead of
  // writing fresh.
}
```

**Cost model:** The warmup costs ~4k input tokens + ~10 output tokens =
~$0.004 at Haiku rates. Turn 1 would otherwise write ~8k tokens to cache =
~$0.008 (at cache-write rate of 1.25× input). Net saving: ~$0.004 per
session.

**Validation:** Run Section 3.3 test.

**Risk:** Adds one extra API call per session. If the session is only 1
turn, the warmup is wasted. Mitigation: only warm when the session prompt
suggests multi-turn work (heuristic: prompt contains "fix", "implement",
"refactor", "add").

### 7.5 Optimization 3: Tool-result summarization via cheap model

**File:** New function in `src/core/policies.ts`

**Implementation sketch:**

```typescript
// When a tool result exceeds the summarization threshold (e.g., 20k chars),
// send it to the cheap model for summarization.
interface SummarizeOptions {
  maxRawChars: number; // threshold before summarization kicks in (e.g., 20000)
  cheapModel: string; // model to use for summarization
  stream: TurnDeps["stream"];
  config: TransportConfig;
}

async function summarizeToolResult(
  toolUseId: string,
  result: string,
  opts: SummarizeOptions,
): Promise<string> {
  if (result.length <= opts.maxRawChars) return result;

  const prompt = [
    {
      role: "user" as const,
      content: [
        {
          type: "text" as const,
          text:
            `Summarize this tool output, preserving file paths, error messages, ` +
            `line numbers, and any specific data mentioned. Be concise but ` +
            `complete — the summary will replace the original in context.\n\n` +
            `OUTPUT:\n${result.slice(0, 50000)}`, // cap at 50k to avoid huge API call
        },
      ],
    },
  ];

  const summaryResult = await opts.stream(
    { ...opts.config, model: opts.cheapModel },
    {
      system: "You are a tool output summarizer.",
      tools: [],
      messages: prompt,
    },
    () => {},
    undefined,
  );

  const summaryText = summaryResult.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("\n");

  return `[summarized ${result.length} chars → ${summaryText.length} chars]\n${summaryText}`;
}
```

**Cost model:** Summarization costs ~$0.002 (5k input tokens at cheap model
rate + ~200 output). The raw result would otherwise occupy ~5k tokens per
turn for the next 3+ turns = $0.075 at uncached input rate. Net saving when
the result lives in context for 3+ turns: $0.07 per large tool result.

**Validation:** Run Section 6.3 A/B but with summarization instead of paging.

**Risk:** The summary may lose critical information (e.g., exact error
line numbers, specific log patterns). Mitigation: always include the
original via ReadMore, and only summarize tool outputs, never file reads.

### 7.6 Optimization 4: Subagent context policies

**File:** `src/core/subagent.ts`

**Bug fix:** The subagent loop builds its message array from scratch and
doesn't apply `pageToolResults`, `deduplicateReads`, or `evictOldResults`.

**Fix:**

1. Pass `sessionState: SessionState` and `maxToolResultChars: number` to
   the subagent turn function
2. Before building each subagent API request, apply:
   ```typescript
   let apiMessages = reduced.messages.map((m) => ({
     role: m.role,
     content: m.content,
   }));
   if (
     deps.sessionState &&
     deps.maxToolResultChars &&
     deps.maxToolResultChars > 0
   ) {
     apiMessages = pageToolResults(
       apiMessages,
       deps.sessionState,
       deps.maxToolResultChars,
     );
   }
   ```
3. Apply `deduplicateReadResult` at tool-execution time inside the subagent
   (same as the main loop does in `loop.ts:397-402`)

**Validation:** Run Section 4.4 test.

---

## 8. QUICK-REFERENCE: COMMANDS CHEAT SHEET

### Start the proxy

```bash
aap serve
```

### Run a single headless task through the proxy

```bash
AAP_SESSION_ID=<name> aap run stackpilot -p --yolo "<prompt>"
```

### Run a full benchmark suite

```bash
cd /tmp/aap
./benchmarks/run.sh <agent> --fixture <fixture> --tag <tag>
```

### Compare two runs

```bash
aap compare --run <tag1> --run <tag2>
aap compare <session-id-1> <session-id-2>
```

### Export a session as markdown

```bash
aap export <session-id>
```

### Export a session as JSON (for scripting)

```bash
aap export <session-id> --json
```

### Inspect specific metrics from a session

```bash
aap export <session-id> --json | jq '{
  requests: .requests | length,
  input: [.requests[].input_tokens] | add,
  cached: [.requests[].cached_input_tokens] | add,
  output: [.requests[].output_tokens] | add,
  cost: [.requests[].cost] | add,
  tools: [.requests[].tool_call_count] | add,
  recommendations: [.recommendations[].kind]
}'
```

### Filter sessions by metadata

```bash
# List all sessions tagged with agent=stackpilot
aap sessions | grep stackpilot

# Or via MCP (if aap mcp is running):
# Use the search_requests tool with filters
```

### Parse raw traces into SQLite

```bash
aap parse
aap parse --all   # re-parse everything
```

### Rebuild the search index

```bash
aap index
```

---

## 9. FIXTURES REFERENCE

| Fixture              | What it stresses                | Why it matters for StackPilot                    |
| -------------------- | ------------------------------- | ------------------------------------------------ |
| `csv-parser`         | Single module read + edit + fix | Cache hit rate on small sessions                 |
| `task-queue`         | Multi-file cross-referencing    | Tool count, search efficiency                    |
| `iterative-fix-plus` | 7 modules, 9 bugs, multi-turn   | Auto-compaction, context growth, cache stability |
| `big-file`           | One 220-line module             | Read dedup, paging threshold                     |
| `many-files`         | 40 tiny modules                 | Search cost, file discovery patterns             |

### Creating a custom fixture

```bash
mkdir -p /tmp/aap/benchmarks/fixtures/<name>/
cd /tmp/aap/benchmarks/fixtures/<name>/

# Create a small project with:
# - package.json
# - src/index.js or similar
# - test/*.test.js with a planted bug
# - TASKS file:

cat > TASKS << 'EOF'
explain|Explain what this project does. Do not change any files.|
locate|Identify the main entry point. Do not change any files.|
fix-bug|The tests are failing. Find and fix the bug. Do not change anything else.|npm test
add-feature|Add X feature. Tests for X already exist but are skipped.|npm test
EOF

# Run against it:
cd /tmp/aap
./benchmarks/run.sh stackpilot --fixture <name> --tag my-test
```

### TASKS file format

```
task-id|prompt|verify-command
```

- `task-id`: unique ID for this task
- `prompt`: exact prompt sent to the agent
- `verify-command`: (optional) shell command run after the agent finishes;
  exit 0 = pass, exit non-zero = fail
- Lines starting with `#` are comments
- If no verify command, the task is read-only (not scored)

---

## 10. TROUBLESHOOTING

### aap serve fails to start

```bash
# Check if something is already on port 8080
lsof -i :8080
# Kill it or use a different port:
aap serve --port 8081
```

### StackPilot can't find the API key

```bash
# Check env:
echo $ANTHROPIC_API_KEY
# Or set it:
export ANTHROPIC_API_KEY=sk-ant-...

# For Bedrock:
echo $CLAUDE_CODE_USE_BEDROCK
echo $AWS_REGION
```

### StackPilot session crashes mid-task

- Check `~/.stackpilot/projects/<slug>/<uuid>.jsonl` for the session trace
- Look for `is_error: true` tool results or `[interrupted by user]` markers
- Common causes:
  - Permission denied on a mutating tool (use `--yolo` for benchmarks)
  - Tool timeout (Bash > 120s default, increase in config)
  - Uncaught tool exception (should produce `is_error: true` — if the
    session is corrupted, this is the `executeTool` catch bug from
    OWNERSHIP_ANALYSIS.md item #7)

### Verify=pass but the agent's code is wrong

The verify command (`npm test`) only checks what the test suite checks.
If the test suite doesn't cover the new code, verify=pass can be a false
positive. Always inspect `benchmarks/runs/<tag>/artifacts/<task>/` (if
`--save-artifacts` was used) for the actual agent output.

### aap compare shows "—" for a metric

The metric wasn't captured for those sessions. Common reasons:

- The session predates a schema migration (run `aap parse --all`)
- The provider didn't report that metric (e.g., cached_input_tokens may
  be 0 for Bedrock-inference-profile sessions)
- The pricing config is missing (cost shows as "—")

### StackPilot consistently fails tasks Claude Code passes

1. Check which specific verify step failed: `cat benchmarks/runs/<tag>/verify/<task>.log`
2. Check if the model is different: `STACKPILOT_MODEL` vs `ANTHROPIC_MODEL`
3. Check for known bugs affecting correctness (Section 7.1)
4. Check if the task uses tools StackPilot doesn't have (Claude Code has 29,
   StackPilot has 14)
5. Try the failing task interactively to see what the agent did:
   ```bash
   stackpilot -c   # resume the session
   ```
