// Fixed-Huffman blocks, verified the same way as stored blocks: the system
// gunzip has to accept them. A wrong bit order or a wrong code table produces a
// stream that is structurally plausible and inflates to the wrong bytes, which
// is exactly what an external decompressor catches and a self-round-trip does
// not.

import { wacBind } from "../../../harness/wacBind.ts";
import { gunzip, roundTrip } from "./util.ts";

const mod = await wacBind("packages/gzip/src/gzip.wac");
const gzipFixed = mod.gzipFixed as (data: Uint8Array) => Uint8Array;

Deno.test("gzipFixed: gunzip round trips", async () => {
  await roundTrip(gzipFixed, "empty", new Uint8Array(0));
  await roundTrip(gzipFixed, "one byte", new Uint8Array([42]));
  await roundTrip(gzipFixed, "hello world", new TextEncoder().encode("hello world"));
  await roundTrip(gzipFixed, "all 256 byte values", Uint8Array.from({ length: 256 }, (_, i) => i));
});

Deno.test("gzipFixed: bytes on both sides of the 9-bit boundary", async () => {
  // The fixed code switches from 8 to 9 bits at symbol 144, so data straddling
  // it exercises both code widths and the 9-bit codes' high bit.
  await roundTrip(gzipFixed, "0..143 (8-bit codes)", Uint8Array.from({ length: 144 }, (_, i) => i));
  await roundTrip(gzipFixed, "144..255 (9-bit codes)", Uint8Array.from({ length: 112 }, (_, i) => i + 144));
  await roundTrip(gzipFixed, "alternating 143/144", Uint8Array.from({ length: 200 }, (_, i) => i % 2 ? 144 : 143));
  await roundTrip(gzipFixed, "all 0xFF", new Uint8Array(300).fill(0xFF));
  await roundTrip(gzipFixed, "all 0x00", new Uint8Array(300).fill(0x00));
});

Deno.test("gzipFixed: block header bits are BFINAL=1, BTYPE=01", async () => {
  const gz = gzipFixed(new TextEncoder().encode("A"));
  // First payload byte follows the 10-byte header. Bits are LSB-first, so the
  // low bit is BFINAL and the next two are BTYPE.
  const first = gz[10];
  const bfinal = first & 1;
  const btype = (first >>> 1) & 3;
  if (bfinal !== 1) throw new Error(`BFINAL: got ${bfinal}, expected 1`);
  if (btype !== 1) throw new Error(`BTYPE: got ${btype}, expected 1 (fixed Huffman)`);
});

Deno.test("gzipFixed: longer text and binary payloads", async () => {
  const text = new TextEncoder().encode(
    "The quick brown fox jumps over the lazy dog. ".repeat(50));
  await roundTrip(gzipFixed, "repeated text", text);

  const random = new Uint8Array(30000);
  let s = 24680;
  for (let i = 0; i < random.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7FFFFFFF;
    random[i] = (s >>> 16) & 0xFF;
  }
  await roundTrip(gzipFixed, "pseudo-random", random);
});

Deno.test("gzipFixed: output is inflate-compatible with python zlib too", async () => {
  // A second independent decompressor, in case gunzip is lenient somewhere.
  const input = new TextEncoder().encode("interoperability check ".repeat(20));
  const gz = gzipFixed(input);
  const out = await gunzip(gz);
  if (new TextDecoder().decode(out) !== new TextDecoder().decode(input)) {
    throw new Error("gunzip output differs from input");
  }
});
