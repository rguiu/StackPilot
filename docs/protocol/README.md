# Claude Code Wire Protocol

Findings from five of my own Claude Code sessions, recorded locally through
the [ai-agent-profiler](https://github.com/rguiu/ai-agent-profiler) proxy.
Every claim is backed by actual API request/response traces in
[fixtures/traces/](../../fixtures/traces/).

**Provenance:** all sessions are mine — captured on my own machine, with my
own API key, from traffic I was a party to. No Claude Code source was
decompiled or copied; StackPilot is an independent client for the public
Messages API. Verbatim system prompt text is not reproduced in these docs —
only structure, sizes, and cache placement.

| File                   | What it documents                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `system-prompt.md`     | System prompt structure — block layout, sizes, cache_control placement, section inventory (no verbatim text) |
| `tools.json`           | Exact 29 tool schemas as sent by Claude Code — keep signatures, rewrite internals                            |
| `cache-breakpoints.md` | cache_control placement per turn, which breakpoints the server uses, what busts the prefix                   |
| `compaction.md`        | /compact protocol: instruction text, injection points, how the summary event flags work                      |
| `transcript-model.md`  | Disk tree ↔ in-memory stack ↔ API body mapping, parentUuid chain, active-path logic                          |
| `compact-session/`     | Same analysis repeated against a session that survived compaction (system prompt, tools, cache-breakpoints)  |

These findings informed every architectural decision in StackPilot — the loop,
the reducer, the cache fingerprint ledger, the compaction protocol, and the
tool schemas are all modeled directly on the behavior observed here.
