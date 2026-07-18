# Golden Traces

NDJSON files recorded through the [ai-agent-profiler](https://github.com/rguiu/ai-agent-profiler)
proxy. Each line is one request or response event — headers, bodies, timing,
and cost. Secret-redacted (API keys, org IDs, personal paths replaced).

| Scenario | Lines | What it exercises |
|----------|-------|-------------------|
| `sp-fresh-baseline/` | 3 req | System prompt, 29 tool schemas, initial cache write |
| `sp-multi-turn-edits/` | 10 req | Stack growth, cache reads, edit loops (Read→Edit→Write) |
| `sp-compact/` | 2 req | /compact summarization protocol, prefix-reuse economics |
| `sp-subagent-todo/` | 16 req | Task sidechains (Agent + TodoWrite), plan mode, system-reminders |
| `sp-rewind/` | 11 req | Transcript tree branching — how rewind creates a new chain |
| `sp-rewind-resume/` | 2 req | -c resume: how the agent reloads the active path |

Each `*.ndjson` file is a complete session dump. Use with
`aap parse --all` to replay and extract metrics, or read directly for raw
request/response inspection.

Also in `../transcripts/`: `rewind-session.jsonl` — the corresponding
Claude Code session JSONL file (the on-disk format StackPilot mirrors).
