// Case mapping and UTF-8, judged against the host over every code point.
//
// The tables were *generated* from the host, so checking them against it looks circular — and for
// the mapping values it partly is. What is not circular, and is what these tests are for:
//
//   - the **lookup** is right. A binary search over 1,459 sorted pairs is exactly the kind of code
//     that is off by one at the ends, and the generator has no opinion about it.
//   - the **boundary** is where it is claimed to be. Simple mapping only: where the host maps one
//     code point to several, this must leave it alone, and the test enumerates those code points
//     rather than assuming there are none.
//   - **UTF-8** is decoded strictly and encoded correctly, which the generator had no part in and
//     which `TextEncoder`/`TextDecoder` judge independently.
//   - `foldEqual` agrees with the host's own case-insensitive comparison over real strings.
//
// Every code point means every code point: 0 to 0x10FFFF, surrogates excluded, on each run.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/unicode/test/probe.wac") as unknown as {
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

const enc = new TextEncoder();
const dec = new TextDecoder();
const MAX = 0x10ffff;

/** The single code point `s` maps to, or -1 if it is not exactly one. */
function single(s: string): number {
  const points = [...s];
  return points.length === 1 ? points[0].codePointAt(0)! : -1;
}

Deno.test("simple case mapping agrees with the host at every code point", () => {
  let checkedLower = 0;
  let checkedUpper = 0;
  const bad: string[] = [];
  for (let cp = 0; cp <= MAX; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);

    // Where the host's mapping is a single code point, this must produce it.
    const lo = single(ch.toLowerCase());
    const wantLower = lo >= 0 ? lo : cp;
    const gotLower = mod.mapLower(cp);
    if (gotLower !== wantLower) {
      if (bad.length < 10) bad.push(`lower U+${cp.toString(16)}: got ${gotLower}, want ${wantLower}`);
    }
    checkedLower++;

    const up = single(ch.toUpperCase());
    const wantUpper = up >= 0 ? up : cp;
    const gotUpper = mod.mapUpper(cp);
    if (gotUpper !== wantUpper) {
      if (bad.length < 10) bad.push(`upper U+${cp.toString(16)}: got ${gotUpper}, want ${wantUpper}`);
    }
    checkedUpper++;
  }
  if (bad.length > 0) throw new Error(`${bad.length}+ disagreed:\n  ${bad.join("\n  ")}`);
  if (checkedLower < 1_000_000) throw new Error(`only checked ${checkedLower} code points`);
});

Deno.test("the simple/full boundary is where it is claimed to be", () => {
  // The code points the host maps to *more than one*, which simple mapping deliberately leaves
  // alone. Enumerated rather than assumed: if the host's data changes and one of these becomes a
  // single-code-point mapping, the test above catches it and this one says the list moved.
  const multi: Array<{ cp: number; kind: string; to: string }> = [];
  for (let cp = 0; cp <= MAX; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    if (single(ch.toUpperCase()) < 0) multi.push({ cp, kind: "upper", to: ch.toUpperCase() });
    if (single(ch.toLowerCase()) < 0) multi.push({ cp, kind: "lower", to: ch.toLowerCase() });
  }
  if (multi.length === 0) throw new Error("no multi-code-point mappings found, so this proves nothing");

  const bad: string[] = [];
  for (const m of multi) {
    const got = m.kind === "upper" ? mod.mapUpper(m.cp) : mod.mapLower(m.cp);
    if (got !== m.cp) {
      bad.push(`U+${m.cp.toString(16)} ${m.kind}s to ${JSON.stringify(m.to)}; simple mapping must leave it, got ${got}`);
    }
  }
  if (bad.length > 0) throw new Error(bad.slice(0, 10).join("\n  "));

  // The famous one, spelled out so the behaviour is visible rather than inferred. The host
  // uppercases ß to SS; simple mapping cannot change a scalar's count, so it leaves it.
  if ("ß".toUpperCase() !== "SS") {
    throw new Error("the host no longer uppercases ß to SS, so this case has moved");
  }
  const got = dec.decode(mod.upper(enc.encode("straße")));
  if (got !== "STRAßE") throw new Error(`ß under simple uppercase: ${got}`);
});

Deno.test("fold is an equivalence, and agrees with case mapping", () => {
  // `fold` had no direct test: it was only ever exercised through `foldEqual`, which would have
  // hidden a fold that was consistently wrong. These are properties the generator cannot satisfy
  // by construction.
  const bad: string[] = [];
  let moved = 0;
  for (let cp = 0; cp <= MAX; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const f = mod.mapFold(cp);
    if (f !== cp) moved++;

    // Idempotent: folding a folded code point changes nothing. A table with a two-step chain in
    // it — x to y to z — would break this and nothing else here would notice.
    if (mod.mapFold(f) !== f) {
      if (bad.length < 10) bad.push(`U+${cp.toString(16)} folds to ${f}, which folds again to ${mod.mapFold(f)}`);
    }

    // Consistent with the classes: two code points with the same single-code-point uppercase are
    // the same letter, so they must fold together.
    const up = single(String.fromCodePoint(cp).toUpperCase());
    if (up >= 0 && up !== cp && mod.mapFold(up) !== f) {
      if (bad.length < 10) {
        bad.push(`U+${cp.toString(16)} and its uppercase U+${up.toString(16)} fold apart: ${f} vs ${mod.mapFold(up)}`);
      }
    }
  }
  if (moved < 1000) throw new Error(`only ${moved} code points fold to anything, which is too few`);

  // The three that are the point of folding at all.
  const classes: number[][] = [
    [0x61, 0x41],                 // a A
    [0x3c3, 0x3c2, 0x3a3],        // σ ς Σ — the contextual form is why fold is lower(upper(x))
    [0x6b, 0x4b, 0x212a],         // k K and the Kelvin sign
  ];
  for (const group of classes) {
    const first = mod.mapFold(group[0]);
    for (const cp of group) {
      if (mod.mapFold(cp) !== first) {
        bad.push(`U+${cp.toString(16)} folds to ${mod.mapFold(cp)}, not ${first} like the rest of its class`);
      }
    }
  }
  if (bad.length > 0) throw new Error(bad.join("\n  "));
});

Deno.test("foldAll folds every scalar, and matches foldEqual", () => {
  // `foldAll` had no test at all. The property that ties it to `foldEqual` is the one worth
  // having: two strings compare fold-equal exactly when their folded forms are identical. If they
  // ever disagree, one of the two is wrong and neither test alone would say which.
  const strings = [
    "", "a", "A", "abc", "ABC", "AbC", "straße", "STRAßE", "ΣΊΣΥΦΟΣ", "σίσυφος",
    "ΠΡΙΒΕΤ", "привет", "ПРИВЕТ", "日本", "K", "k", "K", "ﬁ", "İ",
  ];
  const bad: string[] = [];
  for (const s of strings) {
    const folded = mod.casefold(enc.encode(s));
    // Every scalar in the output is already folded — folding is idempotent on whole strings too.
    const twice = mod.casefold(folded);
    if (dec.decode(twice) !== dec.decode(folded)) {
      bad.push(`${JSON.stringify(s)}: folding twice differs from folding once`);
    }
    for (const other of strings) {
      const bothFolded = dec.decode(mod.casefold(enc.encode(other))) === dec.decode(folded);
      const equal = mod.equalFold(enc.encode(s), enc.encode(other));
      if (bothFolded !== equal) {
        bad.push(`${JSON.stringify(s)} vs ${JSON.stringify(other)}: foldEqual says ${equal}, folded forms say ${bothFolded}`);
      }
    }
  }
  // Invalid input is reported as empty by the probe, and must not be mistaken for a fold.
  if (mod.casefold(new Uint8Array([0xff])).length !== 0) {
    throw new Error("invalid UTF-8 folded to something");
  }
  if (bad.length > 0) throw new Error(bad.slice(0, 10).join("\n  "));
});

Deno.test("mapping whole strings agrees with the host where mapping is simple", () => {
  // Strings built only from code points whose mapping is single, so the host and simple mapping
  // must agree exactly. Built from a wide spread rather than a Latin sample.
  const points: number[] = [];
  for (let cp = 0; cp <= MAX; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const ch = String.fromCodePoint(cp);
    if (single(ch.toLowerCase()) >= 0 && single(ch.toUpperCase()) >= 0) points.push(cp);
    if (points.length > 200000) break;
  }
  let x = 0x1f2e3d4c | 0;
  const next = (): number => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x;
  };
  for (let t = 0; t < 3000; t++) {
    let s = "";
    const n = 1 + (next() % 12);
    for (let i = 0; i < n; i++) s += String.fromCodePoint(points[next() % points.length]);
    const gotLower = dec.decode(mod.lower(enc.encode(s)));
    if (gotLower !== s.toLowerCase()) {
      throw new Error(`lower ${JSON.stringify(s)}: got ${JSON.stringify(gotLower)}, host says ${JSON.stringify(s.toLowerCase())}`);
    }
    const gotUpper = dec.decode(mod.upper(enc.encode(s)));
    if (gotUpper !== s.toUpperCase()) {
      throw new Error(`upper ${JSON.stringify(s)}: got ${JSON.stringify(gotUpper)}, host says ${JSON.stringify(s.toUpperCase())}`);
    }
  }
});

Deno.test("foldEqual agrees with the host's case-insensitive comparison", () => {
  const pairs: Array<[string, string, boolean]> = [
    ["", "", true],
    ["a", "A", true],
    ["abc", "ABC", true],
    ["abc", "abd", false],
    ["abc", "ab", false],
    ["", "a", false],
    ["Straße", "STRAßE", true],
    ["ÅNGSTRÖM", "ångström", true],
    // Greek final sigma. `Σ` lowercases to `σ` at the start of a word and `ς` at the end, so a
    // fold derived from lowercase alone would call these different — see the generator.
    ["ΣΊΣΥΦΟΣ", "σίσυφος", true],
    ["ς", "σ", true],
    ["ΣΣ", "σς", true],
    ["ПРИВЕТ", "привет", true],
    ["日本", "日本", true],
    ["日本", "日语", false],
    ["k", "K", true],
    ["K", "k", true],   // Kelvin sign folds to k
  ];
  const bad: string[] = [];
  for (const [a, b, want] of pairs) {
    const got = mod.equalFold(enc.encode(a), enc.encode(b));
    if (got !== want) bad.push(`${JSON.stringify(a)} vs ${JSON.stringify(b)}: ${got}, want ${want}`);
  }

  // And over random strings. The oracle is uppercase equality, not lowercase: uppercase is the
  // direction that has no contextual forms, so it is the one that puts `ς` and `σ` in the same
  // class. Restricted to code points whose mappings are single in both directions, since that is
  // the subset simple folding claims to handle.
  const points: number[] = [];
  for (let cp = 0x20; cp < 0x2000; cp++) {
    const ch = String.fromCodePoint(cp);
    if (single(ch.toLowerCase()) >= 0 && single(ch.toUpperCase()) >= 0) points.push(cp);
  }
  let x = 0x5150cafe | 0;
  const next = (): number => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x;
  };
  for (let t = 0; t < 4000; t++) {
    let a = "";
    const n = 1 + (next() % 6);
    for (let i = 0; i < n; i++) a += String.fromCodePoint(points[next() % points.length]);
    // Half the time, make b a case variant of a; otherwise something else entirely.
    const b = next() % 2 === 0
      ? [...a].map(c => next() % 2 === 0 ? c.toUpperCase() : c.toLowerCase()).join("")
      : String.fromCodePoint(points[next() % points.length]) + a;
    const want = a.toUpperCase() === b.toUpperCase();
    const got = mod.equalFold(enc.encode(a), enc.encode(b));
    if (got !== want) {
      bad.push(`${JSON.stringify(a)} vs ${JSON.stringify(b)}: ${got}, want ${want}`);
      if (bad.length > 8) break;
    }
  }
  if (bad.length > 0) throw new Error(bad.join("\n  "));
});

Deno.test("UTF-8 encoding matches TextEncoder at every code point", () => {
  let checked = 0;
  for (let cp = 0; cp <= MAX; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const want = enc.encode(String.fromCodePoint(cp));
    const got = mod.encodeOne(cp);
    if (got.length !== want.length) {
      throw new Error(`U+${cp.toString(16)}: ${got.length} bytes, want ${want.length}`);
    }
    for (let i = 0; i < want.length; i++) {
      if (got[i] !== want[i]) throw new Error(`U+${cp.toString(16)} byte ${i}: ${got[i]} vs ${want[i]}`);
    }
    checked++;
  }
  if (checked < 1_000_000) throw new Error(`only checked ${checked}`);
});

Deno.test("UTF-8 decoding round-trips every code point", () => {
  for (let cp = 0; cp <= MAX; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const bytes = enc.encode(String.fromCodePoint(cp));
    const code = mod.decodeCode(bytes, 0);
    const size = mod.decodeSize(bytes, 0);
    if (code !== cp) throw new Error(`U+${cp.toString(16)}: decoded ${code}`);
    if (size !== bytes.length) throw new Error(`U+${cp.toString(16)}: size ${size}, want ${bytes.length}`);
  }
});

Deno.test("invalid UTF-8 is rejected, not replaced", () => {
  // A strict decoder, judged against a strict TextDecoder. Where the platform's default decoder
  // substitutes U+FFFD, `fatal: true` throws — and that is the behaviour being matched.
  const strict = new TextDecoder("utf-8", { fatal: true });
  const cases: number[][] = [
    [0x80], [0xbf], [0xfe], [0xff], [0xf5, 0x80, 0x80, 0x80],
    [0xc0, 0x80], [0xc1, 0xbf],                     // over-long ASCII
    [0xe0, 0x80, 0x80], [0xe0, 0x9f, 0xbf],         // over-long two-byte
    [0xf0, 0x80, 0x80, 0x80], [0xf0, 0x8f, 0xbf, 0xbf],
    [0xed, 0xa0, 0x80], [0xed, 0xbf, 0xbf],         // surrogates
    [0xf4, 0x90, 0x80, 0x80],                       // past U+10FFFF
    [0xc2], [0xe0, 0xa0], [0xf0, 0x9f, 0x98],       // truncated
    [0xc2, 0x41], [0xe0, 0xa0, 0x41],               // a bad continuation
    [0x61, 0x80, 0x62],                             // a stray continuation inside text
  ];
  const bad: string[] = [];
  for (const bytes of cases) {
    const arr = new Uint8Array(bytes);
    let hostOk = true;
    try {
      strict.decode(arr);
    } catch {
      hostOk = false;
    }
    const got = mod.valid(arr);
    if (got !== hostOk) {
      bad.push(`[${bytes.map(b => b.toString(16)).join(" ")}]: wac ${got}, TextDecoder ${hostOk}`);
    }
  }
  // And valid text is accepted.
  for (const s of ["", "a", "café", "日本", "\u{1f600}", "a b"]) {
    if (!mod.valid(enc.encode(s))) bad.push(`rejected valid ${JSON.stringify(s)}`);
  }
  if (bad.length > 0) throw new Error(bad.join("\n  "));
});

Deno.test("scalar counting matches the host", () => {
  for (const s of ["", "a", "abc", "café", "日本語", "\u{1f600}\u{1f601}", "a\u{1f600}b"]) {
    const want = [...s].length;
    const got = mod.scalarCount(enc.encode(s));
    if (got !== want) throw new Error(`${JSON.stringify(s)}: counted ${got}, want ${want}`);
  }
  if (mod.scalarCount(new Uint8Array([0xff])) !== -1) {
    throw new Error("invalid input did not count as -1");
  }
});

Deno.test("random byte strings never crash the decoder", () => {
  // The decoder is fed bytes from the network by anything that uses it, so "returns an answer for
  // every input" is a property worth asserting directly.
  let x = 0x0badc0de | 0;
  const next = (): number => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x;
  };
  const strict = new TextDecoder("utf-8", { fatal: true });
  for (let t = 0; t < 5000; t++) {
    const n = next() % 12;
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = next() & 0xff;
    let hostOk = true;
    try {
      strict.decode(bytes);
    } catch {
      hostOk = false;
    }
    if (mod.valid(bytes) !== hostOk) {
      throw new Error(`[${[...bytes].map(b => b.toString(16)).join(" ")}]: wac ${mod.valid(bytes)}, host ${hostOk}`);
    }
  }
});
