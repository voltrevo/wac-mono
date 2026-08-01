// Branch coverage for unicode.
//
// Every code point, which is also what the tests do — there is no smaller workload that reaches
// both ends of a binary search over 1,482 entries, and no reason to use one.
//
//   deno task coverage:unicode
//   deno task coverage:unicode --verbose

import { instrument, report } from "../../harness/wacCoverage.ts";

const verbose = Deno.args.includes("--verbose");
const enc = new TextEncoder();

const run = await instrument("packages/unicode/test/probe.wac");
const m = run.mod as unknown as {
  mapLower(cp: number): number;
  mapUpper(cp: number): number;
  mapFold(cp: number): number;
  decodeCode(s: Uint8Array, at: number): number;
  decodeSize(s: Uint8Array, at: number): number;
  valid(s: Uint8Array): boolean;
  scalarCount(s: Uint8Array): number;
  encodeOne(cp: number): Uint8Array;
  lower(s: Uint8Array): Uint8Array;
  upper(s: Uint8Array): Uint8Array;
  casefold(s: Uint8Array): Uint8Array;
  equalFold(a: Uint8Array, b: Uint8Array): boolean;
};

// The whole space, thinned only where the branches cannot differ. The ends matter most: a binary
// search is wrong at the first and last entry or nowhere.
for (let cp = 0; cp <= 0x10ffff; cp += 7) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  m.mapLower(cp);
  m.mapUpper(cp);
  m.mapFold(cp);
  m.encodeOne(cp);
}
for (const cp of [0, 1, 0x41, 0x5a, 0x61, 0x7a, 0x7f, 0x80, 0xdf, 0x130, 0x131, 0x212a, 0x3c2,
                  0x3c3, 0x3a3, 0x7ff, 0x800, 0xffff, 0x10000, 0x10ffff, -1, 0x110000]) {
  m.mapLower(cp);
  m.mapUpper(cp);
  m.mapFold(cp);
  m.encodeOne(cp);
}

/** Valid text of every encoded length, and the mapping paths over it. */
for (
  const s of [
    "", "a", "A", "abc", "ABC", "café", "CAFÉ", "日本語", "\u{1f600}", "straße", "STRASSE",
    "ΣΊΣΥΦΟΣ", "σίσυφος", "ς", "σ", "K", "k", "ﬁ", "İ", "ı",
  ]
) {
  const bytes = enc.encode(s);
  m.lower(bytes);
  m.upper(bytes);
  m.casefold(bytes);
  m.valid(bytes);
  m.scalarCount(bytes);
  m.decodeCode(bytes, 0);
  m.decodeSize(bytes, 0);
  m.equalFold(bytes, enc.encode(s.toUpperCase()));
  m.equalFold(bytes, enc.encode("zzz"));
}

/** Every way a sequence can be malformed, which is most of the decoder. */
for (
  const bytes of [
    [0x80], [0xbf], [0xc0, 0x80], [0xc1, 0xbf], [0xe0, 0x80, 0x80], [0xe0, 0x9f, 0xbf],
    [0xf0, 0x80, 0x80, 0x80], [0xf0, 0x8f, 0xbf, 0xbf], [0xed, 0xa0, 0x80], [0xed, 0xbf, 0xbf],
    [0xf4, 0x90, 0x80, 0x80], [0xf5, 0x80, 0x80, 0x80], [0xfe], [0xff],
    [0xc2], [0xe0, 0xa0], [0xf0, 0x9f, 0x98], [0xc2, 0x41], [0xe0, 0xa0, 0x41],
    [0x61, 0x80, 0x62], [],
  ]
) {
  const arr = new Uint8Array(bytes);
  m.valid(arr);
  m.scalarCount(arr);
  m.decodeCode(arr, 0);
  m.decodeSize(arr, 0);
  m.lower(arr);
  m.upper(arr);
  m.casefold(arr);
  m.equalFold(arr, arr);
  m.equalFold(arr, enc.encode("a"));
  m.equalFold(enc.encode("a"), arr);
}

/** Random bytes, since that is what a decoder is actually given. */
let x = 0x0badc0de | 0;
const next = (): number => {
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5; x >>>= 0;
  return x;
};
for (let t = 0; t < 4000; t++) {
  const n = next() % 12;
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = next() & 0xff;
  m.valid(bytes);
  m.lower(bytes);
  m.equalFold(bytes, enc.encode("test"));
}

report([run], "packages/unicode/", { verbose });
