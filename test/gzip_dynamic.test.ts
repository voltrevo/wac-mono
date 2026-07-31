// Dynamic Huffman blocks (BTYPE=10). These carry the code in the block header,
// so a bug can be in the tree, the canonical assignment, the run-length encoding
// of the code lengths, the HLIT/HDIST/HCLEN counts, or the permuted transmission
// order — and any of them yields a stream that gunzip rejects or mis-decodes.

import { wacBind } from "../harness/wacBind.ts";
import { gunzip, pythonGzip, roundTrip } from "./util.ts";

const mod = await wacBind("src/gzip.wac");
const gzipDynamic = mod.gzipDynamic as (data: Uint8Array) => Uint8Array;

Deno.test("gzipDynamic: block header is BFINAL=1, BTYPE=10", () => {
  const gz = gzipDynamic(new TextEncoder().encode("A"));
  const first = gz[10];
  const bfinal = first & 1;
  const btype = (first >>> 1) & 3;
  if (bfinal !== 1) throw new Error(`BFINAL: got ${bfinal}, expected 1`);
  if (btype !== 2) throw new Error(`BTYPE: got ${btype}, expected 2 (dynamic)`);
});

Deno.test("gzipDynamic: degenerate inputs", async () => {
  // Empty input has no literals and no matches, so both trees are built purely
  // from the padding that forceTwo adds. One byte gives a one-symbol literal
  // tree before padding. These are where a one-code tree would appear.
  await roundTrip(gzipDynamic, "empty", new Uint8Array(0));
  await roundTrip(gzipDynamic, "one byte", new Uint8Array([65]));
  await roundTrip(gzipDynamic, "two identical bytes", new Uint8Array([65, 65]));
  await roundTrip(gzipDynamic, "three identical bytes", new Uint8Array([65, 65, 65]));
  await roundTrip(gzipDynamic, "one distinct pair", new Uint8Array([0, 255]));
});

Deno.test("gzipDynamic: no matches at all (distance tree unused)", async () => {
  // Strictly increasing bytes never repeat a 3-byte sequence, so no distance
  // symbol is ever emitted and that whole tree exists only as padding.
  await roundTrip(gzipDynamic, "0..255 ascending", Uint8Array.from({ length: 256 }, (_, i) => i));
  const noRepeat = new Uint8Array(3000);
  let s = 7;
  for (let i = 0; i < noRepeat.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7FFFFFFF;
    noRepeat[i] = (s >>> 16) & 0xFF;
  }
  await roundTrip(gzipDynamic, "pseudo-random 3000", noRepeat);
});

Deno.test("gzipDynamic: skewed frequencies force the 15-bit code limit", async () => {
  // Fibonacci-distributed byte frequencies drive natural code lengths past 15
  // bits, so this exercises the frequency-scaling rebuild inside a real block
  // rather than only in the unit probe.
  const counts: number[] = [1, 1];
  for (let i = 2; i < 32; i++) counts.push(counts[i - 1] + counts[i - 2]);
  const parts: number[] = [];
  for (let sym = 0; sym < counts.length; sym++) {
    // Interleave so the bytes do not form long runs that LZ77 would collapse.
    for (let k = 0; k < Math.min(counts[sym], 4000); k++) parts.push(sym * 7 + 1);
  }
  // Shuffle deterministically to break up runs.
  let s = 424242;
  for (let i = parts.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7FFFFFFF;
    const j = (s >>> 8) % (i + 1);
    const tmp = parts[i]; parts[i] = parts[j]; parts[j] = tmp;
  }
  await roundTrip(gzipDynamic, "fibonacci-skewed", new Uint8Array(parts));
});

Deno.test("gzipDynamic: code-length RLE symbols 16, 17 and 18", async () => {
  // Symbol 18 covers zero runs of 11-138 and 17 covers 3-10: an alphabet of a
  // few byte values leaves most of the 286 literal/length lengths at zero, so
  // both appear. Symbol 16 repeats a nonzero length 3-6 times, which needs
  // several symbols sharing a length — a flat distribution over many values.
  await roundTrip(gzipDynamic, "two byte values (long zero runs)",
    Uint8Array.from({ length: 4000 }, (_, i) => i % 2 ? 0x41 : 0x42));

  await roundTrip(gzipDynamic, "flat over 256 values (equal lengths -> sym 16)",
    Uint8Array.from({ length: 256 * 12 }, (_, i) => i % 256));

  // A gap in the middle of the alphabet, forcing zero runs between used symbols.
  await roundTrip(gzipDynamic, "sparse alphabet",
    Uint8Array.from({ length: 3000 }, (_, i) => (i % 8) * 32));
});

Deno.test("gzipDynamic: HLIT/HDIST trimming across match-length ranges", async () => {
  // Which length symbols get used decides how far HLIT can be trimmed. Short
  // matches only use low length symbols; a 258-byte match uses symbol 285, the
  // very last one, so nothing can be trimmed.
  await roundTrip(gzipDynamic, "short matches only",
    new TextEncoder().encode("abcabcabc".repeat(20)));
  await roundTrip(gzipDynamic, "maximum-length matches", new Uint8Array(2000).fill(0x5A));
});

Deno.test("gzipDynamic: larger payloads round trip", async () => {
  const text = new TextEncoder().encode(
    "The quick brown fox jumps over the lazy dog. ".repeat(2000));
  await roundTrip(gzipDynamic, "repeated prose 90000", text);

  const mixed = new Uint8Array(150000);
  let s = 31337;
  for (let i = 0; i < mixed.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7FFFFFFF;
    mixed[i] = i % 1009 === 0 ? (s >>> 16) & 0xFF : (i % 97) & 0xFF;
  }
  await roundTrip(gzipDynamic, "150000 mixed", mixed);
});

Deno.test("gzipDynamic: competitive with gzip -6", async () => {
  const enc = new TextEncoder();
  const samples: [string, Uint8Array][] = [
    ["prose", enc.encode("DEFLATE is a lossless compressed data format that compresses data using a combination of the LZ77 algorithm and Huffman coding. ".repeat(30))],
    ["pattern", enc.encode("abcdefgh".repeat(2000))],
    ["zeros", new Uint8Array(5000)],
    ["words", enc.encode(Array.from({ length: 3000 }, (_, i) => ["the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog"][i % 8]).join(" "))],
  ];
  for (const [name, data] of samples) {
    const ours = gzipDynamic(data).length;
    const theirs = (await pythonGzip(data, 6)).length;
    // Allow 15% worse; in practice this lands at or just under gzip because a
    // single block avoids gzip's per-block header overhead on inputs this size.
    if (ours > theirs * 1.15) {
      throw new Error(`${name}: ${ours} bytes vs gzip ${theirs} — more than 15% worse`);
    }
  }
});

Deno.test("gzipDynamic: beats fixed Huffman on real data", async () => {
  const gzipFixed = mod.gzipFixed as (data: Uint8Array) => Uint8Array;
  const data = new TextEncoder().encode(
    "the quick brown fox jumps over the lazy dog ".repeat(200));
  const dyn = gzipDynamic(data).length;
  const fix = gzipFixed(data).length;
  if (dyn >= fix) {
    throw new Error(`dynamic (${dyn}) should beat fixed (${fix}) on skewed text`);
  }
  const out = await gunzip(gzipDynamic(data));
  if (new TextDecoder().decode(out) !== new TextDecoder().decode(data)) {
    throw new Error("dynamic output did not round trip");
  }
});
