# Compaction protocol (observed from the sp-compact recording)

Source: `fixtures/traces/sp-compact/67f2653b….ndjson` — a `/compact` run
captured from Claude Code 2.1.212 (13 messages, 27 tools at the time).

## Request shape

Compaction is a **normal messages request on the main model** — same
system prompt, same tool schemas, same conversation — with one appended
user message containing the summarization instruction. aap classifies it
`kind=compact` by that last message, not by the system block.

**Why tools are still attached:** the request is a pure append to the
cached prefix (tools → system → history), so the entire conversation bills
at cache-read rates (0.1x). Dropping the schemas would change the prefix
and re-bill the whole history at full price. Claude instead _textually_
forbids tool use — the instruction opens with:

> "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools. […] Tool calls
> will be REJECTED and will waste your only turn"

## Instruction structure (paraphrased)

1. Text-only directive (above).
2. Task: "detailed summary of the conversation … technical details, code
   patterns, and architectural decisions … essential for continuing
   development work without losing context."
3. A required `<analysis>` scratchpad block (chain-of-thought before the
   summary), then a `<summary>` block with prescribed sections.

## Result handling

The summary becomes the new conversation base: the transcript gets a
**user event flagged `isCompactSummary: true`**; subsequent requests send
`[summary, …new messages]`. Pre-compact history stays on disk (tree is
append-only) but is no longer sent.

## stackpilot divergences (deliberate)

| Claude Code                          | stackpilot                                             |
| ------------------------------------ | ------------------------------------------------------ |
| `<analysis>` + `<summary>` blocks    | summary only — we don't pay for scratchpad output      |
| their instruction text               | our own wording, same structural intent                |
| auto threshold undisclosed (~92-95%) | `autoCompactAtTokens` config, default 160k, 0 disables |
| recap/microcompact variants          | not implemented (PLAN #7)                              |

Same disk semantics (`isCompactSummary` field name kept for fixture
compatibility), same prefix-reuse economics, same append-only guarantee.
