import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aapOrigin, formatHits, searchHistoryTool } from "./history.js";

let server: Server;
let origin: string;
let lastUrl: string | null = null;
let failMode: "none" | "http500" | "notjson" | "notarray" = "none";

beforeAll(async () => {
  server = createServer((req, res) => {
    lastUrl = req.url ?? null;
    if (failMode === "http500") {
      res.writeHead(500).end("boom");
      return;
    }
    if (failMode === "notjson") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("this is not json");
      return;
    }
    if (failMode === "notarray") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unexpected object" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify([
        {
          requestId: "r1",
          sessionId: "sp-rewind-12345",
          ts: "2026-07-17T15:30:00Z",
          source: "user",
          snippet: "rename divide to [safeDivide]",
          cwd: "/tmp/scratch",
          client: "claude",
        },
      ]),
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(0, () => {
      resolve();
    }),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no port");
  origin = `http://127.0.0.1:${address.port}`;
  process.env.STACKPILOT_AAP_ORIGIN = origin;
});

afterAll(() => {
  delete process.env.STACKPILOT_AAP_ORIGIN;
  server.close();
});

describe("aapOrigin", () => {
  it("prefers the explicit env var", () => {
    expect(aapOrigin({ STACKPILOT_AAP_ORIGIN: "http://x:1" })).toBe(
      "http://x:1",
    );
  });

  it("derives the origin from ANTHROPIC_BASE_URL", () => {
    expect(
      aapOrigin({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8080/sess/anthropic" }),
    ).toBe("http://127.0.0.1:8080");
  });

  it("falls back to the default proxy origin", () => {
    expect(aapOrigin({})).toBe("http://127.0.0.1:8080");
  });
});

describe("SearchHistory", () => {
  it("queries /search and formats hits", async () => {
    const res = await searchHistoryTool.execute(
      { query: "safeDivide", limit: 5 },
      "/cwd",
    );
    expect(res.isError).toBeUndefined();
    expect(lastUrl).toBe("/search?q=safeDivide&limit=5");
    expect(res.output).toContain("safeDivide");
    expect(res.output).toContain("sp-rewind-12");
    expect(res.output).toContain("claude");
  });

  it("degrades on HTTP errors without throwing", async () => {
    failMode = "http500";
    const res = await searchHistoryTool.execute({ query: "x" }, "/cwd");
    failMode = "none";
    expect(res.isError).toBe(true);
    expect(res.output).toContain("HTTP 500");
  });

  it("degrades when the server is unreachable", async () => {
    process.env.STACKPILOT_AAP_ORIGIN = "http://127.0.0.1:1";
    const res = await searchHistoryTool.execute({ query: "x" }, "/cwd");
    process.env.STACKPILOT_AAP_ORIGIN = origin;
    expect(res.isError).toBe(true);
    expect(res.output).toContain("not reachable");
  });

  it("degrades on a non-JSON body without throwing", async () => {
    failMode = "notjson";
    const res = await searchHistoryTool.execute({ query: "x" }, "/cwd");
    failMode = "none";
    expect(res.isError).toBe(true);
    expect(res.output).toContain("unreadable");
  });

  it("degrades on a non-array JSON body without throwing", async () => {
    failMode = "notarray";
    const res = await searchHistoryTool.execute({ query: "x" }, "/cwd");
    failMode = "none";
    expect(res.isError).toBe(true);
    expect(res.output).toContain("unexpected shape");
  });
});

describe("formatHits", () => {
  it("reports the empty case", () => {
    expect(formatHits([])).toContain("no matches");
  });
});
