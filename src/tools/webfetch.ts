// WebFetch: HTTP GET tool. Fetch a URL and return its content as text.
// Read-only, run-permitless. Uses native fetch, 10s default timeout.

import { requireString, type ToolDef, type ToolResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 80_000;

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "stackpilot/0.1",
        accept:
          "text/html,text/plain,application/json,text/markdown;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });
  } finally {
    clearTimeout(timer);
  }
}

export const webFetchTool: ToolDef = {
  name: "WebFetch",
  description:
    "Fetch content from a URL. Returns the response body as text. " +
    "Use for reading documentation, API responses, or any web content " +
    "the agent needs to understand.",
  runPermitless: true,
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch",
      },
      format: {
        type: "string",
        enum: ["text", "markdown", "html"],
        description: "Preferred content format. Defaults to text.",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (max 30). Defaults to 10.",
      },
    },
    required: ["url"],
  },
  async execute(input): Promise<ToolResult> {
    const url = requireString(input, "url");
    const format = (input.format as string | undefined) ?? "text";
    const timeoutSec =
      typeof input.timeout === "number"
        ? Math.min(input.timeout, 30) * 1000
        : DEFAULT_TIMEOUT_MS;

    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return {
        output: `invalid URL: must start with http:// or https://`,
        isError: true,
      };
    }

    let res: Response;
    try {
      res = await fetchWithTimeout(url, timeoutSec);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return { output: `request timed out after ${timeoutSec / 1000}s` };
      }
      return {
        output: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }

    let body: string;
    try {
      body = await res.text();
    } catch {
      return { output: "failed to read response body" };
    }

    const contentType = res.headers.get("content-type") ?? "";
    const truncated =
      body.length > MAX_OUTPUT
        ? `${body.slice(0, MAX_OUTPUT)}\n\n[truncated ${body.length - MAX_OUTPUT} chars]`
        : body;

    const header = [
      `Status: ${res.status} ${res.statusText}`,
      `Content-Type: ${contentType}`,
      `Length: ${body.length} chars`,
      `Requested format: ${format}`,
      "",
    ].join("\n");

    return { output: `${header}\n${truncated}` };
  },
};
