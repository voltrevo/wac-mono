// LZ77 correctness. gunzip accepting the stream proves the back-references
// decode to the right bytes; these tests additionally prove the references are
// there at all (a literals-only compressor would pass the round-trip tests) and
// push on the boundaries of the length and distance code tables.

import { wacBind } from "../harness/wacBind.ts";
import { gunzip, roundTrip } from "./util.ts";

const mod = await wacBind("src/gzip.wac");
const gzipFixed = mod.gzipFixed as (data: Uint8Array) => Uint8Array;

Deno.test("lz77: repetitive input actually compresses", async () => {
  const input = new TextEncoder().encode("abcdefgh".repeat(2000)); // 16000 bytes
  const gz = gzipFixed(input);
  // 18 bytes of container overhead. Literals-only would be >= the input size.
  if (gz.length >= input.length / 4) {
    throw new Error(`expected strong compression, got ${gz.length} from ${input.length} bytes`);
  }
  await roundTrip(gzipFixed, "repeated 8-byte pattern", input);
});

Deno.test("lz77: overlapping match — dist 1 over a long run", async () => {
  // The hardest case in DEFLATE: distance 1, length up to 258, so the copy
  // reads bytes it is itself writing. A decompressor doing memcpy instead of a
  // byte-at-a-time copy gets this wrong, and so does an encoder that caps
  // length at the distance.
  for (const n of [3, 4, 5, 258, 259, 260, 300, 1000, 5000]) {
    await roundTrip(gzipFixed, `${n} identical bytes`, new Uint8Array(n).fill(0x61));
  }
  // Overlap with distance 2 and 3 as well.
  await roundTrip(gzipFixed, "ab x 3000", new TextEncoder().encode("ab".repeat(3000)));
  await roundTrip(gzipFixed, "abc x 2000", new TextEncoder().encode("abc".repeat(2000)));
});

Deno.test("lz77: every length code, 3..258", async () => {
  // For each match length, build input that forces exactly that length: a
  // unique prefix, then a run of `len` bytes repeated once, then a byte that
  // breaks the match. Covers all 29 length symbols and their extra-bit widths.
  for (let len = 3; len <= 258; len++) {
    const unit = new Uint8Array(len);
    for (let i = 0; i < len; i++) unit[i] = (i * 7 + len) & 0xFF;
    const input = new Uint8Array(len * 2 + 1);
    input.set(unit, 0);
    input.set(unit, len);
    input[len * 2] = 0xAA;
    const out = await gunzip(gzipFixed(input));
    if (out.length !== input.length) {
      throw new Error(`len ${len}: got ${out.length} bytes, expected ${input.length}`);
    }
    for (let i = 0; i < input.length; i++) {
      if (out[i] !== input[i]) throw new Error(`len ${len}: byte ${i} differs`);
    }
  }
});

Deno.test("lz77: distances across the whole 32 KiB window", async () => {
  // Place a distinctive 8-byte pattern, `gap` filler bytes, then the pattern
  // again — forcing a match at distance gap+8. Sweeps every distance code
  // including the 13-extra-bit ones near the window limit.
  const pattern = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const gaps = [0, 1, 2, 4, 8, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512,
                768, 1024, 1536, 2048, 3072, 4096, 6144, 8192, 12288, 16384,
                24576, 32000, 32760 - 8];
  for (const gap of gaps) {
    const input = new Uint8Array(pattern.length * 2 + gap);
    input.set(pattern, 0);
    // Filler that will not itself match the pattern.
    let s = gap + 1;
    for (let i = 0; i < gap; i++) {
      s = (s * 1103515245 + 12345) & 0x7FFFFFFF;
      input[pattern.length + i] = 0x80 | ((s >>> 16) & 0x3F);
    }
    input.set(pattern, pattern.length + gap);
    const out = await gunzip(gzipFixed(input));
    if (out.length !== input.length) {
      throw new Error(`gap ${gap}: got ${out.length}, expected ${input.length}`);
    }
    for (let i = 0; i < input.length; i++) {
      if (out[i] !== input[i]) throw new Error(`gap ${gap}: byte ${i} differs`);
    }
  }
});

Deno.test("lz77: input larger than the 32 KiB window", async () => {
  // Beyond 32768 the encoder must stop referencing positions it can no longer
  // encode a distance for.
  const input = new Uint8Array(200000);
  let s = 13579;
  for (let i = 0; i < input.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7FFFFFFF;
    // Mix of structure and noise so there are matches at many distances.
    input[i] = i % 997 === 0 ? (s >>> 16) & 0xFF : (i % 251) & 0xFF;
  }
  await roundTrip(gzipFixed, "200000 mixed bytes", input);
});

Deno.test("lz77: text corpus compresses and round trips", async () => {
  const text = `
    DEFLATE is a lossless compressed data format that compresses data using a
    combination of the LZ77 algorithm and Huffman coding, with efficiency
    comparable to the best currently available general-purpose compression
    methods. The data can be produced or consumed, even for an arbitrarily long
    sequentially presented input data stream, using only an a priori bounded
    amount of intermediate storage.
  `.repeat(30);
  const input = new TextEncoder().encode(text);
  const gz = gzipFixed(input);
  const ratio = gz.length / input.length;
  if (ratio > 0.2) {
    throw new Error(`expected ratio under 0.2 on repeated prose, got ${ratio.toFixed(3)}`);
  }
  await roundTrip(gzipFixed, "prose", input);
});
