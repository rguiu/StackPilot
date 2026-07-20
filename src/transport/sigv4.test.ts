import { describe, expect, it } from "vitest";
import {
  isAwsHost,
  resolveAwsCredentials,
  signBedrockRequest,
} from "./sigv4.js";
import type { TransportConfig } from "./stream.js";

const cfg: TransportConfig = {
  baseUrl: "https://bedrock-runtime.eu-west-1.amazonaws.com",
  apiKey: "",
  model: "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
  maxTokens: 8192,
  provider: "bedrock",
  region: "eu-west-1",
};

describe("isAwsHost", () => {
  it("is true for bedrock-runtime AWS hosts", () => {
    expect(isAwsHost("https://bedrock-runtime.eu-west-1.amazonaws.com/x")).toBe(
      true,
    );
  });
  it("is false for a local proxy", () => {
    expect(isAwsHost("http://127.0.0.1:8080/model/x/invoke")).toBe(false);
  });
});

describe("resolveAwsCredentials", () => {
  it("returns null without keys", () => {
    expect(resolveAwsCredentials({})).toBeNull();
  });
  it("reads keys + optional session token", () => {
    const c = resolveAwsCredentials({
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "tok",
    });
    expect(c).toEqual({
      accessKeyId: "AKIA",
      secretAccessKey: "secret",
      sessionToken: "tok",
    });
  });
});

describe("signBedrockRequest", () => {
  it("returns plain headers for a proxy host (no signing)", async () => {
    const headers = await signBedrockRequest(
      { ...cfg, baseUrl: "http://127.0.0.1:8080" },
      "http://127.0.0.1:8080/model/x/invoke-with-response-stream",
      "{}",
      {},
    );
    expect(headers.authorization).toBeUndefined();
    expect(headers["content-type"]).toBe("application/json");
  });

  it("throws for an AWS host without credentials", async () => {
    await expect(
      signBedrockRequest(
        cfg,
        `${cfg.baseUrl}/model/x/invoke-with-response-stream`,
        "{}",
        { AWS_REGION: "eu-west-1" },
      ),
    ).rejects.toThrow(/credentials/);
  });

  it("produces a deterministic SigV4 Authorization header for an AWS host", async () => {
    const url = `${cfg.baseUrl}/model/${encodeURIComponent(cfg.model)}/invoke-with-response-stream`;
    const env = {
      AWS_REGION: "eu-west-1",
      AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
      AWS_SECRET_ACCESS_KEY: "secretkeyexample",
    };
    const fixedDate = new Date("2026-07-20T09:22:16.000Z");
    const headers = await signBedrockRequest(
      cfg,
      url,
      '{"x":1}',
      env,
      fixedDate,
    );
    expect(headers["x-amz-date"]).toBe("20260720T092216Z");
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20260720\/eu-west-1\/bedrock\/aws4_request, SignedHeaders=[a-z;-]+, Signature=[0-9a-f]{64}$/,
    );
    // Signing is deterministic for a fixed date/key/body.
    const again = await signBedrockRequest(cfg, url, '{"x":1}', env, fixedDate);
    expect(again.authorization).toBe(headers.authorization);
    // A different body changes the signature.
    const other = await signBedrockRequest(cfg, url, '{"x":2}', env, fixedDate);
    expect(other.authorization).not.toBe(headers.authorization);
  });

  it("includes the session token header when present", async () => {
    const url = `${cfg.baseUrl}/model/x/invoke-with-response-stream`;
    const headers = await signBedrockRequest(cfg, url, "{}", {
      AWS_REGION: "eu-west-1",
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "secret",
      AWS_SESSION_TOKEN: "session-tok",
    });
    expect(headers["x-amz-security-token"]).toBe("session-tok");
  });
});
