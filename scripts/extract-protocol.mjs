#!/usr/bin/env node
// Extract Claude Code wire-protocol artifacts from aap NDJSON traces.
//
// Usage: node scripts/extract-protocol.mjs <trace-dir> <out-dir>
//
// Reads every *.ndjson trace in <trace-dir> (one file per request),
// reassembles the JSON request bodies, and writes:
//   system-prompt.md     — system blocks of the largest main-agent request
//   tools.json           — tool schemas of that request
//   cache-breakpoints.md — cache_control placement across every request

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";

const [traceDir, outDir] = process.argv.slice(2);
if (!traceDir || !outDir) {
  console.error("usage: extract-protocol.mjs <trace-dir> <out-dir>");
  process.exit(1);
}

function readTrace(file) {
  const records = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const req = records.find((r) => r.type === "request");
  const body = Buffer.concat(
    records
      .filter((r) => r.type === "request_body")
      .map((r) => Buffer.from(r.data, "base64")),
  ).toString("utf8");
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    // non-JSON body (e.g. preflight HEAD) — skip
  }
  return { file: basename(file), meta: req, json };
}

const traces = readdirSync(traceDir)
  .filter((f) => f.endsWith(".ndjson"))
  .map((f) => readTrace(join(traceDir, f)))
  .filter((t) => t.json && Array.isArray(t.json.messages));

if (traces.length === 0) {
  console.error(`no message requests found in ${traceDir}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

// Largest request = richest system prompt + full tool set.
const main = traces.reduce((a, b) =>
  JSON.stringify(b.json).length > JSON.stringify(a.json).length ? b : a,
);

// --- system-prompt.md -------------------------------------------------------
const sys = Array.isArray(main.json.system)
  ? main.json.system
  : [{ type: "text", text: String(main.json.system ?? "") }];
const sysMd = [
  `# System prompt (${main.file}, model ${main.json.model})`,
  "",
  ...sys.flatMap((block, i) => [
    `## Block ${i}${block.cache_control ? ` — cache_control: ${JSON.stringify(block.cache_control)}` : ""}`,
    "",
    "````text",
    block.text ?? JSON.stringify(block, null, 2),
    "````",
    "",
  ]),
].join("\n");
writeFileSync(join(outDir, "system-prompt.md"), sysMd);

// --- tools.json --------------------------------------------------------------
writeFileSync(
  join(outDir, "tools.json"),
  JSON.stringify(main.json.tools ?? [], null, 2) + "\n",
);

// --- cache-breakpoints.md -----------------------------------------------------
function breakpoints(json) {
  const spots = [];
  const sysArr = Array.isArray(json.system) ? json.system : [];
  sysArr.forEach((b, i) => {
    if (b.cache_control) spots.push(`system[${i}]`);
  });
  (json.tools ?? []).forEach((t, i) => {
    if (t.cache_control) spots.push(`tools[${i}]:${t.name}`);
  });
  (json.messages ?? []).forEach((m, i) => {
    const content = Array.isArray(m.content) ? m.content : [];
    content.forEach((c, j) => {
      if (c.cache_control) spots.push(`messages[${i}].content[${j}]:${m.role}`);
    });
  });
  return spots;
}

const bpMd = [
  "# cache_control placement per request",
  "",
  "| trace | model | msgs | tools | breakpoints |",
  "| --- | --- | --- | --- | --- |",
  ...traces.map((t) => {
    const bp = breakpoints(t.json);
    return `| ${t.file.slice(0, 8)} | ${t.json.model} | ${t.json.messages.length} | ${(t.json.tools ?? []).length} | ${bp.join(", ") || "none"} |`;
  }),
  "",
].join("\n");
writeFileSync(join(outDir, "cache-breakpoints.md"), bpMd);

console.log(
  `extracted from ${traces.length} requests -> ${outDir} (main: ${main.file}, ${sys.length} system blocks, ${(main.json.tools ?? []).length} tools)`,
);
