# Claude Code Wire Protocol

Findings extracted from 5 recorded Claude Code sessions through the
[ai-agent-profiler](https://github.com/rguiu/ai-agent-profiler) proxy.
Every claim is backed by actual API request/response traces in
[fixtures/traces/](../../fixtures/traces/).

| File                   | What it documents                                                                                              |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `system-prompt.md`     | Full system prompt (255 lines, ~8KB), 3-block structure, what varies per request kind                          |
| `tools.json`           | Exact 29 tool schemas as sent by Claude Code — keep signatures, rewrite internals                              |
| `cache-breakpoints.md` | cache_control placement per turn, which breakpoints the server uses, what busts the prefix                     |
| `compaction.md`        | /compact protocol: instruction text, injection points, how the summary event flags work                        |
| `transcript-model.md`  | Disk tree ↔ in-memory stack ↔ API body mapping, parentUuid chain, active-path logic                            |
| `compact-session/`     | Same extractions repeated against a session that survived compaction (system prompt, tools, cache-breakpoints) |

These findings informed every architectural decision in StackPilot — the loop,
the reducer, the cache fingerprint ledger, the compaction protocol, and the
tool schemas are all direct behavioral clones of what was observed here.
