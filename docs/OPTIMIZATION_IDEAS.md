# Optimization Ideas

StackPilot has full control of the message stack — we send raw API requests
and can manipulate every byte. These are ideas for reducing cost and latency
that are not yet implemented.

---

## Cache Optimizations

### 1. Minimal tool loading (highest ROI) — ✅ IMPLEMENTED

**Status:** Shipped behind `progressiveTools` (config, default off). Sessions
activate only `CORE_TOOLS` (Read/Grep/Glob) up front; other allowed tools are
advertised by name in the system prompt and their schemas activate on first
use via `registry.activate()` in `loop.ts` dispatch. See `src/tools/index.ts`
(active vs allow set) and the "Additional tools (loaded on demand)" prompt
section.

**What:** Start sessions with a minimal tool set (Read, Grep, Glob) and add
tools (Write, Edit, Bash) lazily when the model first tries to use them.

**Why:** The tool schemas are ~40% of the static prefix. Starting with fewer
tools means a smaller cache prefix, which is both cheaper to write and more
likely to fit within the minimum-cacheable-length threshold.

**Tradeoff:** The first time a new tool is added, the cache re-writes. But
every subsequent turn hits cache on the larger prefix. Net savings over a
typical 10+ turn session is ~30% of cache write costs.

**Implementation:** `registry.setEnabled()` already supports incremental
changes. On `dispatchTool` unknown-tool error, add the tool and retry.

### 2. Cache pre-warming

**What:** On session start, send a dummy request (empty user message)
to establish the cache before the first real turn.

**Why:** The first user turn always writes to cache (fresh prefix).
Pre-warming moves that cost to session startup and the first real turn
already reads from cache.

**Cost:** One extra API call (system + tools only, ~4K tokens input,
minimal output). Saves full cache write cost on turn 1.

**Implementation:** After session start, run a no-op `streamMessage` with
a single user text block `"cache warmup"`.

### 3. Fourth cache breakpoint — ✅ IMPLEMENTED

**Status:** Shipped. `applyCacheControl` now marks an anchor breakpoint on the
first non-empty message's last block in addition to the moving breakpoint on
the last, splitting the message prefix into stable-early and volatile-recent
segments. Collapses to a single marker on a one-message stack, and the total
never exceeds the 4-marker server limit (2 system + anchor + moving). See
`src/core/cache.ts` and the cache tests.

**What:** Use the 4th allowed breakpoint to split the messages prefix into
two segments — early context (stable) and recent context (volatile).

**Why:** Currently have 3 breakpoints (static system, dynamic instructions,
moving messages). The 4th would isolate recent tool results from early
conversation history. Evicting a recent tool result would only bust
the recent segment, keeping early context cached.

**Implementation:** Place a cache_control marker on the first user message's
last content block (early context) and another on the last message's last
block (moving). Requires marking two blocks per `toApiMessages` call.

### 4. Tool stripping for compaction

**What:** The compact request sends all tool schemas to preserve the cache
prefix, even though compaction doesn't use tools. Optionally strip tools
when the cache write cost exceeds the re-write cost.

**Why:** For large tool sets (all 14 tools), the tool schemas are ~6K chars.
On a cache miss, this gets re-written. On some models, the tool schema
cost exceeds the prefix re-write cost.

**Implementation:** Compare `toolsByteSize * cacheWriteRate` against
`prefixByteSize * cacheReadRate`. If smaller, strip tools and accept
the cache bust.

---

## Tool Optimizations

### 5. Lazy tool execution

**What:** Defer tool execution for tools the model might not need.
Pre-validate inputs without running.

**Why:** Models sometimes call Read/Grep with incorrect paths,
then correct and re-call. The first call is wasted.

**Tradeoff:** Adds complexity. Currently YAGNI.

### 6. Batch tool results

**What:** Combine consecutive tool_result blocks into a single block
when the model makes parallel tool calls.

**Why:** Each tool_result is a separate content block in the user message.
Merging reduces the content block count and slightly reduces token count.

**Tradeoff:** Changes the tool_result format. May confuse the model.

---

## Provider Optimizations

### 7. Provider routing

**What:** Route requests to different providers based on the task.
Haiku for compaction/summarization. Sonnet for primary reasoning.

**Why:** Compaction is a utility call — cheap model works fine.
Primary reasoning needs a capable model.

**Status:** Partially implemented (`cheapModel` in config routes
compaction to a cheaper model). Not yet: per-turn model selection,
automatic routing based on task type.

### 8. API-level retries with progressive fallback

**What:** On failure, retry with exponential backoff. On repeated
failure, fall back to a different model or provider.

**Why:** Currently retries same model. A fallback chain increases
reliability.

**Implementation:** `streamWithRetry` accepts an array of configs.
Each retry tries the next config in the chain.

---

## Context Window Optimizations

### 9. Sliding window with weighted retention

**What:** Evict tool_results by age but keep diagnostic results
(errors, test failures) longer than successful results.

**Why:** Successful tool results are rarely re-read. Error results
are often referenced in debugging.

**Implementation:** Tag tool_results with a priority score.
`evictOldResults` keeps higher-priority results for more turns.

### 10. Tool result summarization

**What:** When a tool_result exceeds the paging threshold, replace it
with an AI-generated summary instead of raw truncation.

**Why:** Truncation loses context. A summary preserves the key information
at a fraction of the tokens.

**Cost:** Uses a cheap model call for summarization. Net savings when
the summarized tool_result would otherwise occupy 3+ turns of context.

---

## TUI Optimizations

### 11. Three-pane full-screen TUI

**What:** Alternate screen buffer with top metadata pane, middle
scrollable response pane, and bottom input/status pane.

**Why:** Claude-like UX. Metadata and input always visible, output
scrolls independently.

**Status:** Attempted, not fully working. See `src/tui/screen.ts`.
Key challenge: readline keypress handling conflicts with alternate
screen buffer. Needs custom input handling or Ink framework.

### 12. Streaming markdown with syntax highlighting

**What:** Color code blocks by language, render diffs inline,
highlight file paths and line numbers.

**Why:** Better readability for code-heavy responses.

**Status:** Markdown renderer exists (`src/tui/markdown.ts`).
Syntax highlighting not implemented — needs a language tokenizer
or lightweight library like `highlight.js`.

---

## Not Yet Prioritized

- Persistent shell (working directory state survives across commands)
- Multi-agent orchestration (Workflow DSL, Agent coordination)
- MCP / plugin integration
- WebFetch / WebSearch tools
- GitHub integration (PR creation, issue linking)
