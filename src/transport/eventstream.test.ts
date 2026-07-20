import { describe, expect, it } from "vitest";
import { bedrockEvents, encodeBedrockFrame } from "./eventstream.js";
import { assembleStream } from "./stream.js";

// Build a ReadableStream that emits the given byte chunks, so we can exercise
// the frame decoder's cross-chunk buffering.
function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]!);
      } else {
        controller.close();
      }
    },
  });
}

function concat(arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

const EVENTS = [
  '{"type":"message_start","message":{"model":"m","usage":{"input_tokens":8}}}',
  '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
  '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
  '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
];

describe("bedrockEvents frame decoding", () => {
  it("decodes each frame back to its inner event JSON", async () => {
    const frames = EVENTS.map(encodeBedrockFrame);
    const out: string[] = [];
    for await (const ev of bedrockEvents(streamOf(frames))) out.push(ev);
    expect(out).toEqual(EVENTS);
  });

  it("reassembles frames split across chunk boundaries", async () => {
    // One big buffer, then re-chunked at awkward offsets mid-frame.
    const all = concat(EVENTS.map(encodeBedrockFrame));
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < all.length; i += 7) {
      chunks.push(all.slice(i, i + 7));
    }
    const out: string[] = [];
    for await (const ev of bedrockEvents(streamOf(chunks))) out.push(ev);
    expect(out).toEqual(EVENTS);
  });

  it("feeds assembleStream to produce the full turn (end-to-end)", async () => {
    const frames = EVENTS.map(encodeBedrockFrame);
    const streamed: string[] = [];
    const result = await assembleStream(bedrockEvents(streamOf(frames)), (d) =>
      streamed.push(d),
    );
    expect(streamed.join("")).toBe("Hello world");
    expect(result.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage.input_tokens).toBe(8);
    expect(result.usage.output_tokens).toBe(2);
    expect(result.model).toBe("m");
  });

  it("surfaces an exception frame as a thrown error", async () => {
    // Hand-build an exception frame (message-type header = "exception").
    const payload = new TextEncoder().encode('{"message":"throttled"}');
    const enc = new TextEncoder();
    const headerName = enc.encode(":message-type");
    const headerVal = enc.encode("exception");
    const header = new Uint8Array(
      1 + headerName.length + 1 + 2 + headerVal.length,
    );
    const hv = new DataView(header.buffer);
    let p = 0;
    hv.setUint8(p, headerName.length);
    p += 1;
    header.set(headerName, p);
    p += headerName.length;
    hv.setUint8(p, 7);
    p += 1;
    hv.setUint16(p, headerVal.length);
    p += 2;
    header.set(headerVal, p);

    const total = 12 + header.length + payload.length + 4;
    const frame = new Uint8Array(total);
    const dv = new DataView(frame.buffer);
    dv.setUint32(0, total);
    dv.setUint32(4, header.length);
    frame.set(header, 12);
    frame.set(payload, 12 + header.length);

    await expect(async () => {
      for await (const _ of bedrockEvents(streamOf([frame]))) {
        void _;
      }
    }).rejects.toThrow(/throttled/);
  });
});
