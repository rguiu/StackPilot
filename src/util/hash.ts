import { createHash } from "node:crypto";

export function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function sha256Truncated(value: string, len: number = 16): string {
  return createHash("sha256").update(value).digest("hex").slice(0, len);
}
