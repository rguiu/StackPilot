// AWS SigV4 signing for native (direct-to-AWS) Bedrock. No @aws-sdk dependency
// — just node:crypto. Kept minimal: signs the one request shape we send
// (POST invoke-with-response-stream to bedrock-runtime).
//
// Proxy mode (cfg.baseUrl is not an amazonaws.com host) needs no signing — the
// gateway signs — so signBedrockRequest returns plain headers there. Native
// mode requires resolvable static credentials in the environment
// (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / optional AWS_SESSION_TOKEN).
// SSO/role-profile resolution is intentionally out of scope: run `aws sso
// login` + `aws configure export-credentials --format env`, or use the proxy.

import { createHash, createHmac } from "node:crypto";
import type { TransportConfig } from "./stream.js";

const SERVICE = "bedrock";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export function resolveAwsCredentials(
  env: NodeJS.ProcessEnv,
): AwsCredentials | null {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return null;
  return {
    accessKeyId,
    secretAccessKey,
    ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
  };
}

// True when the URL targets AWS directly (so we must sign). Proxy/localhost
// hosts return false — the gateway handles auth.
export function isAwsHost(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(".amazonaws.com");
  } catch {
    return false;
  }
}

const BASE_HEADERS: Record<string, string> = {
  "content-type": "application/json",
  accept: "application/vnd.amazon.eventstream",
};

// Build request headers for a Bedrock call. Native AWS host → full SigV4;
// otherwise just the base headers (proxy signs). `now` is injectable for
// deterministic tests. Async by design: the callsite awaits it, and future
// credential providers (SSO/role assumption) resolve asynchronously — so the
// seam stays Promise-returning even though the static-cred path doesn't await.
// eslint-disable-next-line @typescript-eslint/require-await
export async function signBedrockRequest(
  cfg: TransportConfig,
  url: string,
  body: string,
  env: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): Promise<Record<string, string>> {
  if (!isAwsHost(url)) {
    return { ...BASE_HEADERS };
  }

  const region = cfg.region ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  if (!region) {
    throw new Error(
      "native Bedrock requires a region (set AWS_REGION or config.region)",
    );
  }
  const creds = resolveAwsCredentials(env);
  if (!creds) {
    throw new Error(
      "native Bedrock requires AWS credentials in the environment " +
        "(AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY). Run `aws configure " +
        "export-credentials --format env`, or point baseUrl at a signing proxy.",
    );
  }

  const u = new URL(url);
  const amzDate = toAmzDate(now); // 20260720T092216Z
  const dateStamp = amzDate.slice(0, 8); // 20260720

  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    host: u.host,
    "x-amz-date": amzDate,
    ...(creds.sessionToken
      ? { "x-amz-security-token": creds.sessionToken }
      : {}),
  };

  const payloadHash = sha256Hex(body);

  // Canonical request.
  const signedHeaderNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders =
    signedHeaderNames
      .map((h) => `${h}:${headers[headerKey(headers, h)]?.trim() ?? ""}`)
      .join("\n") + "\n";
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    "POST",
    u.pathname,
    u.searchParams.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  // String to sign.
  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  // Signing key + signature.
  const signingKey = deriveSigningKey(
    creds.secretAccessKey,
    dateStamp,
    region,
    SERVICE,
  );
  const signature = hmac(signingKey, stringToSign).toString("hex");

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return headers;
}

// --- primitives ------------------------------------------------------------

function headerKey(headers: Record<string, string>, lower: string): string {
  return Object.keys(headers).find((k) => k.toLowerCase() === lower) ?? lower;
}

function toAmzDate(d: Date): string {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function deriveSigningKey(
  secret: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}
