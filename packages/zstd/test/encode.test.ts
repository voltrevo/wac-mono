// The encoder, judged by zstd's own decoder.
//
// This is the test the decoder never had available to it: an encoder's first valid frame is
// checkable end to end, because Node must decompress it to exactly what went in. Our own
// decoder is checked too, but second — a bug shared by both halves would hide there, and the
// point of Node is that it cannot share one.
//
// Ratio is measured but only loosely asserted. What is worth failing on is *expansion*, and
// beating a stored frame on data that obviously compresses; the rest is recorded so a change
// that quietly loses ground is visible in the numbers rather than in a threshold nobody trusts.

import { wacBind } from "../../../harness/wacBind.ts";
import { refDecompress } from "./reference.ts";

const enc = await wacBind("packages/zstd/src/encode.wac") as unknown as {
  compress(data: Uint8Array): Uint8Array;
};
const dec = await wacBind("packages/zstd/src/frame.wac") as unknown as {
  decompress(src: Uint8Array): Uint8Array;
};

const e = new TextEncoder();

function b64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192));
  return btoa(s);
}
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/** Decompress with the reference decoder — in this process now; see `test/reference.ts`. */
function nodeDecompress(frames: Uint8Array[]): (Uint8Array | null)[] {
  return frames.map(refDecompress);
}

function same(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return i;
  }
  return -2;
}

function prng(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    out[i] = s & 0xff;
  }
  return out;
}

/** Chosen for the encoder paths they reach: no matches, only matches, block boundaries. */
function corpus(): [string, Uint8Array][] {
  return [
    ["empty", new Uint8Array(0)],
    ["one byte", e.encode("x")],
    ["two bytes", e.encode("ab")],
    // Shorter than the minimum match, so nothing can match at all.
    ["under the minimum match", e.encode("ab")],
    ["no repetition", e.encode("abcdefghijklmnop")],
    ["one match", e.encode("abcabc")],
    ["a match at the very end", e.encode("xyzabcabc")],
    ["short repetition", e.encode("hello hello hello hello world")],
    ["prose", e.encode("the quick brown fox jumps over the lazy dog. ".repeat(300))],
    ["json", e.encode(JSON.stringify(Array.from({ length: 1500 }, (_, i) => ({ id: i, name: "item" + i }))))],
    ["one long run", new Uint8Array(50000).fill(0x61)],
    // Incompressible, so every block falls back to raw.
    ["random", prng(200000, 7)],
    // Past one block, so the block loop runs and a match can reach across the boundary.
    ["multi-block", e.encode("Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(9000))],
    // Exactly a block, and one byte over.
    ["exactly one block", prng(131072, 3)],
    ["one byte over a block", prng(131073, 5)],
    // Compressible and incompressible together, so both block kinds appear in one frame.
    ["mixed", new Uint8Array([...e.encode("aaaa".repeat(20000)), ...prng(60000, 11), ...e.encode("bbbb".repeat(20000))])],
    ["every byte value", new Uint8Array(Array.from({ length: 100000 }, (_, i) => i & 0xff))],
  ];
}

Deno.test("zstd decompresses what we produce, back to the original", async () => {
  const cases = corpus();
  const frames = cases.map(([, d]) => enc.compress(d));
  const back = nodeDecompress(frames);

  for (let i = 0; i < cases.length; i++) {
    const [name, data] = cases[i];
    const got = back[i];
    if (got === null) throw new Error(`${name}: zstd refused our ${frames[i].length}-byte frame`);
    const at = same(got, data);
    if (at === -1) throw new Error(`${name}: zstd read ${got.length} bytes, want ${data.length}`);
    if (at >= 0) throw new Error(`${name}: zstd's output differs at byte ${at} of ${data.length}`);
  }
});

Deno.test("and so does our own decoder", () => {
  // Second, not first. A misunderstanding shared by both halves would pass here and fail above,
  // which is exactly why Node goes first.
  for (const [name, data] of corpus()) {
    const got = dec.decompress(enc.compress(data));
    const at = same(got, data);
    if (at !== -2) {
      throw new Error(`${name}: ${at === -1 ? `${got.length} bytes, want ${data.length}` : `differs at ${at}`}`);
    }
  }
});

Deno.test("it never expands past a stored frame", () => {
  // The property that matters most: a compressor that grows its input is worse than none. Each
  // block falls back to raw when the compressed form is not smaller, so the ceiling is the
  // input plus the frame's own frame — 14 bytes of header and checksum, and 3 per block.
  for (const [name, data] of corpus()) {
    const blocks = Math.max(1, Math.ceil(data.length / 131072));
    const ceiling = data.length + 14 + 3 * blocks;
    const got = enc.compress(data).length;
    if (got > ceiling) {
      throw new Error(`${name}: ${got} bytes for ${data.length} in, above the stored ceiling of ${ceiling}`);
    }
  }
});

Deno.test("data that obviously compresses, obviously compresses", () => {
  // A canary rather than a threshold: these are inputs where any working match finder wins by a
  // wide margin, so the numbers are loose enough to survive a change of strategy and tight
  // enough to catch a match finder that has stopped finding matches.
  const cases: [string, Uint8Array, number][] = [
    ["one repeated byte", new Uint8Array(50000).fill(0x61), 200],
    ["one repeated phrase", e.encode("the quick brown fox. ".repeat(5000)), 300],
    ["a long file of one line", e.encode("2026-08-02 INFO nothing happened\n".repeat(3000)), 400],
  ];
  for (const [name, data, ceiling] of cases) {
    const got = enc.compress(data).length;
    if (got > ceiling) throw new Error(`${name}: ${got} bytes for ${data.length}, expected under ${ceiling}`);
  }
});

Deno.test("fuzz: every shape and size round trips through zstd", async () => {
  // Sizes and shapes rather than content: the block boundary, the minimum match, and the last
  // few bytes of a buffer are where an encoder goes wrong, and those are functions of length.
  let seed = 0xBEEF | 0;
  const rand = (n: number): number => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed % n;
  };

  const inputs: Uint8Array[] = [];
  const names: string[] = [];
  for (let i = 0; i < 80; i++) {
    const n = rand(6000);
    const kind = rand(4);
    let data: Uint8Array;
    if (kind === 0) {
      data = prng(n, seed);
      names.push(`${n} random bytes`);
    } else if (kind === 1) {
      data = new Uint8Array(n).fill(0x41 + rand(26));
      names.push(`${n} of one byte`);
    } else if (kind === 2) {
      const unit = "abcdefghij".slice(0, 1 + rand(9));
      data = e.encode(unit.repeat(Math.ceil(n / unit.length)).slice(0, n));
      names.push(`${n} of "${unit}"`);
    } else {
      // Repetition with noise, which is where matches and literals mix.
      const noise = prng(n, seed);
      const out = new Uint8Array(n);
      for (let j = 0; j < n; j++) out[j] = j % 20 < 15 ? 0x61 + (j % 5) : noise[j];
      data = out;
      names.push(`${n} mixed`);
    }
    inputs.push(data);
  }

  const frames = inputs.map(d => enc.compress(d));
  const back = nodeDecompress(frames);
  for (let i = 0; i < inputs.length; i++) {
    const got = back[i];
    if (got === null) throw new Error(`${names[i]}: zstd refused the frame`);
    const at = same(got, inputs[i]);
    if (at !== -2) {
      throw new Error(`${names[i]}: ${at === -1 ? `${got.length} bytes, want ${inputs[i].length}` : `differs at ${at}`}`);
    }
  }
});

import { frameShapes } from "./frames.ts";

Deno.test("fitted tables are chosen where they pay, and not where they do not", () => {
  // Both codings are built per block and the shorter kept, so a bug that made fitted tables
  // always lose would cost ~25% of the output and break nothing. This asserts the choice is
  // actually being made, in both directions.
  const big = e.encode(JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({ id: i, name: "item" + i }))));
  const modes = new Set<string>();
  for (const m of frameShapes(enc.compress(big)).modes) {
    for (const part of m.split(" ")) modes.add(part.split(":")[1] ?? part);
  }
  if (!modes.has("fse")) throw new Error(`no block chose fitted tables: saw ${[...modes]}`);

  // A block with few sequences cannot recover the cost of describing three tables, so it should
  // keep the predefined ones.
  const small = e.encode("hello hello hello hello world");
  const smallModes = new Set<string>();
  for (const m of frameShapes(enc.compress(small)).modes) {
    for (const part of m.split(" ")) smallModes.add(part.split(":")[1] ?? part);
  }
  if (!smallModes.has("predefined")) {
    throw new Error(`a tiny block paid for its own tables: saw ${[...smallModes]}`);
  }
});

Deno.test("fitted tables are worth what they claim to be", () => {
  // A regression canary on the ratio, not a target. These are the figures fitted tables bought
  // when they landed; a change that quietly loses a quarter of them should say so.
  const cases: [string, Uint8Array, number][] = [
    ["json", e.encode(JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({ id: i, name: "item" + i, active: i % 3 === 0 })))), 18000],
    ["logs", e.encode(Array.from({ length: 6000 }, (_, i) => `2026-08-02T10:00:00Z INFO request id=${i} path=/api/items status=200 ms=${i % 97}\n`).join("")), 28000],
  ];
  for (const [name, data, ceiling] of cases) {
    const got = enc.compress(data).length;
    if (got > ceiling) {
      throw new Error(`${name}: ${got} bytes for ${data.length}, expected under ${ceiling} — fitted tables may have stopped being chosen`);
    }
  }
});

Deno.test("literals are coded when that helps, and left alone when it does not", () => {
  // Three kinds of literals section, each chosen for a different reason: RLE when there is one
  // distinct byte, Huffman when the alphabet is narrow enough to describe and the coding pays,
  // raw when neither. A bug that stopped choosing Huffman would cost 8% on base64-heavy data and
  // break nothing, so the choice is asserted rather than assumed.
  const kindsOf = (d: Uint8Array) => new Set(frameShapes(enc.compress(d)).kinds);

  // A long run of one byte: the matcher covers all of it but the first three, so the literals
  // that survive are three copies of the same byte — one distinct value, which is what RLE is.
  const rle = new Uint8Array(50000).fill(0x61);
  if (!kindsOf(rle).has("rle")) throw new Error(`one repeated literal byte: saw ${[...kindsOf(rle)]}`);

  // A narrow alphabet with high entropy and matches too short to cover it — the shape Huffman
  // exists for, and what base64 payloads look like.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let s = 0x1234 | 0;
  const parts: string[] = [];
  for (let i = 0; i < 40000; i++) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    parts.push(alphabet[(s >>> 8) % 64]);
    if (i % 64 === 63) parts.push("\nkey ");
  }
  const kinds = kindsOf(e.encode(parts.join("")));
  if (!kinds.has("compressed")) throw new Error(`base64 literals were not coded: saw ${[...kinds]}`);

  // A byte above 128 puts the alphabet beyond what a directly-written tree can describe, so the
  // literals stay raw. That is a real limitation, and this is what would notice it changing.
  // Needs matches, or the whole block falls back to raw and there is no literals section to
  // look at: high-entropy bytes across the full range, with a repeated marker planted so the
  // block is compressed and the literals between the markers keep their wide alphabet.
  const marker = e.encode("=== a marker phrase that certainly repeats ===");
  const wideParts: number[] = [];
  let x = 0x9e37 | 0;
  for (let i = 0; i < 400; i++) {
    for (let j = 0; j < 50; j++) {
      x ^= x << 13; x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5; x >>>= 0;
      wideParts.push(x & 0xff);
    }
    for (const b of marker) wideParts.push(b);
  }
  const wide = new Uint8Array(wideParts);
  const wideKinds = kindsOf(wide);
  if (!wideKinds.has("raw")) throw new Error(`a 256-symbol alphabet: saw ${[...wideKinds]}`);
});

Deno.test("coding the literals is worth what it claims", () => {
  // A canary on the figure Huffman literals bought when they landed. base64 is where it matters
  // most: 64 symbols in 8-bit bytes means a quarter of every literal byte is dead weight.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let s = 0xBEEF | 0;
  const parts: string[] = [];
  for (let i = 0; i < 60000; i++) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    parts.push(alphabet[(s >>> 8) % 64]);
  }
  const data = e.encode(parts.join(""));
  const got = enc.compress(data).length;
  // Incompressible by matching, so this is almost purely the literal coding: six bits a byte
  // plus the frame, against eight bits stored.
  const ceiling = Math.ceil(data.length * 6.4 / 8);
  if (got > ceiling) {
    throw new Error(`${got} bytes for ${data.length} of base64, expected under ${ceiling} — literals may not be coded`);
  }
});

Deno.test("literals sections at every header width", async () => {
  // The literals header comes in three widths for compressed sections, and which one is used
  // depends on how many literals a block ends up with. Everything in the corpus above produced
  // small ones — the widest form went untested and was wrong, writing six bytes of a five-byte
  // header with the fields in the wrong places. Real data at full size found it; nothing smaller
  // did, because a block needs 16 KiB of literals before that form is reached.
  //
  // So: inputs built to land in each width, and checked against zstd rather than ourselves.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let s = 0x51ded | 0;
  const roll = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };

  // High-entropy base64 with a repeated marker: the marker matches, everything else is a
  // literal, so literal volume tracks the input size closely.
  const build = (n: number): Uint8Array => {
    const parts: string[] = [];
    for (let i = 0; i < n; i++) {
      parts.push(alphabet[(roll() >>> 8) % 64]);
      if (i % 70 === 69) parts.push("\nid ed25519 ");
    }
    return e.encode(parts.join(""));
  };

  const cases = [800, 5_000, 20_000, 90_000, 300_000, 900_000];
  const inputs = cases.map(build);
  const frames = inputs.map(d => enc.compress(d));
  const back = nodeDecompress(frames);
  for (let i = 0; i < inputs.length; i++) {
    const got = back[i];
    if (got === null) throw new Error(`${cases[i]} symbols: zstd refused the frame`);
    const at = same(got, inputs[i]);
    if (at !== -2) {
      throw new Error(`${cases[i]} symbols: ${at === -1 ? `${got.length} bytes, want ${inputs[i].length}` : `differs at ${at}`}`);
    }
    // And our own decoder, which has to agree with zstd about the same bytes.
    const ours = dec.decompress(frames[i]);
    if (same(ours, inputs[i]) !== -2) throw new Error(`${cases[i]} symbols: our decoder disagrees`);
  }
});
