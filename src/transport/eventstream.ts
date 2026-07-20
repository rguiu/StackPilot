// AWS `vnd.amazon.eventstream` binary frame decoder — the wire format Bedrock
// uses for invoke-with-response-stream (NOT SSE).
//
// Each message is length-prefixed:
//   [4]  total byte length (big-endian, includes these prelude bytes + CRCs)
//   [4]  headers byte length (big-endian)
//   [4]  prelude CRC32 (over the first 8 bytes)
//   [headers]  key/value header pairs (:event-type, :content-type, ...)
//   [payload]  the message body
//   [4]  message CRC32 (over everything before it)
//
// For Bedrock's Anthropic models the payload is JSON `{"bytes":"<base64>"}`,
// and the base64 decodes to the SAME Anthropic SSE event JSON the shared
// assembler already understands (message_start, content_block_delta, ...).
// This module does the framing + unwrap; it does not interpret the events.
//
// We verify lengths but skip CRC validation: the transport is TLS/localhost
// and a corrupt frame surfaces as a JSON parse skip downstream — validating
// CRC32 would add a lookup table for no real robustness gain here.

const PRELUDE_BYTES = 12; // 4 total-len + 4 headers-len + 4 prelude-crc
const MESSAGE_CRC_BYTES = 4;

// Extract the innermost Anthropic event JSON from one decoded frame payload.
// Bedrock wraps it as {"bytes":"<base64 of the event JSON>"}. Returns null
// for frames without a decodable event (e.g. exception frames handled above).
function unwrapPayload(payloadText: string): string | null {
  let outer: unknown;
  try {
    outer = JSON.parse(payloadText);
  } catch {
    return null;
  }
  if (typeof outer !== "object" || outer === null) return null;
  const bytes = (outer as { bytes?: unknown }).bytes;
  if (typeof bytes !== "string") return null;
  try {
    return Buffer.from(bytes, "base64").toString("utf8");
  } catch {
    return null;
  }
}

// Stream decoder: feed raw byte chunks from the HTTP body, yields each inner
// Anthropic event JSON string. Buffers partial frames across chunk boundaries.
export async function* bedrockEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  let buf = new Uint8Array(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.length > 0) {
        const merged = new Uint8Array(buf.length + value.length);
        merged.set(buf);
        merged.set(value, buf.length);
        buf = merged;
      }

      // Emit every complete frame currently in the buffer.
      for (;;) {
        if (buf.length < PRELUDE_BYTES) break;
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const totalLen = view.getUint32(0);
        if (totalLen < PRELUDE_BYTES + MESSAGE_CRC_BYTES) {
          // Corrupt length — bail on this stream rather than spin.
          throw new Error(`bedrock event-stream: bad frame length ${totalLen}`);
        }
        if (buf.length < totalLen) break; // wait for more bytes

        const headersLen = view.getUint32(4);
        const headersStart = PRELUDE_BYTES;
        const payloadStart = headersStart + headersLen;
        const payloadEnd = totalLen - MESSAGE_CRC_BYTES;

        const event = decodeFrame(
          buf,
          view,
          headersStart,
          payloadStart,
          payloadEnd,
        );
        if (event !== null) yield event;

        buf = buf.slice(totalLen);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function decodeFrame(
  buf: Uint8Array,
  view: DataView,
  headersStart: number,
  payloadStart: number,
  payloadEnd: number,
): string | null {
  // Parse headers only to detect exception/error frames; skip on the happy path.
  const messageType = readHeaderString(
    view,
    headersStart,
    payloadStart,
    ":message-type",
  );
  if (messageType === "exception" || messageType === "error") {
    const text = new TextDecoder().decode(
      buf.subarray(payloadStart, payloadEnd),
    );
    throw new Error(`bedrock stream error: ${text.slice(0, 400)}`);
  }
  const payloadText = new TextDecoder().decode(
    buf.subarray(payloadStart, payloadEnd),
  );
  return unwrapPayload(payloadText);
}

// Read a single string header by name, or null. Walks the header block; used
// sparingly (just :message-type), so a linear scan per frame is fine.
function readHeaderString(
  view: DataView,
  start: number,
  end: number,
  wanted: string,
): string | null {
  let pos = start;
  const dec = new TextDecoder();
  while (pos < end) {
    const nameLen = view.getUint8(pos);
    pos += 1;
    const name = dec.decode(
      new Uint8Array(view.buffer, view.byteOffset + pos, nameLen),
    );
    pos += nameLen;
    const valueType = view.getUint8(pos);
    pos += 1;
    if (valueType === 6 || valueType === 7) {
      const valLen = view.getUint16(pos);
      pos += 2;
      if (name === wanted) {
        return dec.decode(
          new Uint8Array(view.buffer, view.byteOffset + pos, valLen),
        );
      }
      pos += valLen;
    } else {
      // Non-string header before the one we want: skip using the same widths
      // as skipHeaders, then continue.
      pos = skipOneValue(view, pos, valueType);
      if (pos < 0) return null;
    }
  }
  return null;
}

function skipOneValue(view: DataView, pos: number, valueType: number): number {
  switch (valueType) {
    case 0:
    case 1:
      return pos;
    case 2:
      return pos + 1;
    case 3:
      return pos + 2;
    case 4:
      return pos + 4;
    case 5:
    case 8:
      return pos + 8;
    case 9:
      return pos + 16;
    default:
      return -1;
  }
}

// Exported for tests: encode an inner event JSON into a single Bedrock frame
// (message-type "event", payload {"bytes": base64}). Mirrors the decoder so a
// round-trip test can prove framing correctness without a live Bedrock call.
export function encodeBedrockFrame(eventJson: string): Uint8Array {
  const payloadObj = JSON.stringify({
    bytes: Buffer.from(eventJson, "utf8").toString("base64"),
  });
  const payload = new TextEncoder().encode(payloadObj);

  const headers = encodeHeaders([
    [":event-type", "chunk"],
    [":content-type", "application/json"],
    [":message-type", "event"],
  ]);

  const totalLen =
    PRELUDE_BYTES + headers.length + payload.length + MESSAGE_CRC_BYTES;
  const out = new Uint8Array(totalLen);
  const view = new DataView(out.buffer);
  view.setUint32(0, totalLen);
  view.setUint32(4, headers.length);
  view.setUint32(8, 0); // prelude CRC (not validated on decode)
  out.set(headers, PRELUDE_BYTES);
  out.set(payload, PRELUDE_BYTES + headers.length);
  view.setUint32(totalLen - 4, 0); // message CRC (not validated)
  return out;
}

function encodeHeaders(pairs: [string, string][]): Uint8Array {
  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const [name, value] of pairs) {
    const nameBytes = enc.encode(name);
    const valBytes = enc.encode(value);
    const head = new Uint8Array(1 + nameBytes.length + 1 + 2 + valBytes.length);
    const dv = new DataView(head.buffer);
    let p = 0;
    dv.setUint8(p, nameBytes.length);
    p += 1;
    head.set(nameBytes, p);
    p += nameBytes.length;
    dv.setUint8(p, 7); // string
    p += 1;
    dv.setUint16(p, valBytes.length);
    p += 2;
    head.set(valBytes, p);
    parts.push(head);
  }
  const total = parts.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of parts) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}
