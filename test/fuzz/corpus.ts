// Input generators for differential fuzzing.
//
// Random bytes alone are a weak corpus: they are incompressible, so they only
// ever exercise the literal path and never produce a match, a length symbol or a
// distance symbol. Each generator below targets a different part of the format,
// and the shapes that historically break DEFLATE implementations — long runs
// (overlapping copies), matches at exactly the window edge, alphabets that skew
// the Huffman tree — get their own.
//
// Everything is driven by an explicit seed, so a failing case is reproducible
// from its index alone.

/** Deterministic LCG. Not good randomness; good reproducibility. */
export function makeRng(seed: number): () => number {
  let s = (seed | 0) || 1;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) & 0x7FFFFFFF;
    return s >>> 8;
  };
}

const WORDS = [
  "the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog", "deflate",
  "huffman", "compression", "window", "literal", "distance", "length", "symbol",
  "block", "stream", "byte", "bit", "code", "tree", "table", "match",
];

export type Generator = (rng: () => number, size: number) => Uint8Array;

/** Uniform random bytes: all literals, no matches, worst case for ratio. */
const incompressible: Generator = (rng, size) => {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = rng() & 0xFF;
  return out;
};

/** Runs of a repeated byte: overlapping copies at distance 1. */
const runs: Generator = (rng, size) => {
  const out = new Uint8Array(size);
  let i = 0;
  while (i < size) {
    const len = 1 + (rng() % 300);
    const b = rng() & 0xFF;
    for (let k = 0; k < len && i < size; k++) out[i++] = b;
  }
  return out;
};

/** Word-ish text: skewed byte frequencies plus frequent short matches. */
const text: Generator = (rng, size) => {
  const parts: string[] = [];
  let n = 0;
  while (n < size) {
    const w = WORDS[rng() % WORDS.length];
    parts.push(w);
    n += w.length + 1;
  }
  return new TextEncoder().encode(parts.join(" ")).slice(0, size);
};

/** Mostly zeros with occasional noise: very long zero runs in the code lengths. */
const sparse: Generator = (rng, size) => {
  const out = new Uint8Array(size);
  const hits = 1 + (rng() % 20);
  for (let k = 0; k < hits; k++) out[rng() % Math.max(1, size)] = rng() & 0xFF;
  return out;
};

/** A repeating period, so matches land at one predictable distance. */
const periodic: Generator = (rng, size) => {
  const period = 1 + (rng() % 300);
  const unit = new Uint8Array(period);
  for (let i = 0; i < period; i++) unit[i] = rng() & 0xFF;
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = unit[i % period];
  return out;
};

/**
 * A distinctive block repeated at a distance near the 32 KiB window edge —
 * where a distance is either just encodable or just past the limit.
 */
const windowEdge: Generator = (rng, size) => {
  const out = new Uint8Array(Math.max(size, 40000));
  for (let i = 0; i < out.length; i++) out[i] = 0x80 | (rng() & 0x3F);
  const pat = new Uint8Array(64);
  for (let i = 0; i < pat.length; i++) pat[i] = rng() & 0xFF;
  const gaps = [32700, 32760, 32768, 32770, 32800];
  const gap = gaps[rng() % gaps.length];
  out.set(pat, 0);
  if (gap + pat.length < out.length) out.set(pat, gap);
  return out;
};

/** Few distinct byte values: a small, heavily skewed alphabet. */
const smallAlphabet: Generator = (rng, size) => {
  const k = 1 + (rng() % 5);
  const alphabet = new Uint8Array(k);
  for (let i = 0; i < k; i++) alphabet[i] = rng() & 0xFF;
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = alphabet[rng() % k];
  return out;
};

/**
 * Exponentially skewed frequencies, which drive natural Huffman code lengths
 * past the 15-bit limit and exercise the rebuild.
 */
const skewed: Generator = (rng, size) => {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    // Most draws land on a few symbols; the tail is very rare.
    let v = 0;
    let r = rng() % 1024;
    while (r > 1 && v < 40) { r >>>= 1; v++; }
    out[i] = (v * 6 + 3) & 0xFF;
  }
  return out;
};

/** Concatenation of other shapes, so statistics shift within one stream. */
const mixed: Generator = (rng, size) => {
  const chunks: Uint8Array[] = [];
  let n = 0;
  const gens = [incompressible, runs, text, sparse, periodic, smallAlphabet];
  while (n < size) {
    const g = gens[rng() % gens.length];
    const chunk = g(rng, 1 + (rng() % Math.max(1, Math.min(4000, size - n + 1))));
    chunks.push(chunk);
    n += chunk.length;
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out.slice(0, Math.max(size, 1) === 1 ? n : n);
};

export const GENERATORS: [string, Generator][] = [
  ["incompressible", incompressible],
  ["runs", runs],
  ["text", text],
  ["sparse", sparse],
  ["periodic", periodic],
  ["windowEdge", windowEdge],
  ["smallAlphabet", smallAlphabet],
  ["skewed", skewed],
  ["mixed", mixed],
];

/**
 * Build the corpus. Sizes deliberately cluster around the awkward values —
 * 0, 1, 2, 3 (the minimum match), 258 (the maximum), and the 65535 stored-block
 * boundary — rather than being uniformly random.
 */
export function buildCorpus(count: number, seed: number): { name: string; data: Uint8Array }[] {
  const rng = makeRng(seed);
  const out: { name: string; data: Uint8Array }[] = [];

  // Always include the degenerate sizes first, across every generator.
  const edgeSizes = [0, 1, 2, 3, 4, 5, 257, 258, 259, 65534, 65535, 65536];
  for (const [name, gen] of GENERATORS) {
    for (const size of edgeSizes) {
      out.push({ name: `${name}/${size}`, data: gen(rng, size) });
    }
  }

  // Then fill the rest with random shapes and sizes.
  while (out.length < count) {
    const [name, gen] = GENERATORS[rng() % GENERATORS.length];
    const size = rng() % 40000;
    out.push({ name: `${name}/${size}`, data: gen(rng, size) });
  }

  return out.slice(0, Math.max(count, edgeSizes.length * GENERATORS.length));
}
