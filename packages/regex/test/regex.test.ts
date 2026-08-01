// A backtracking regex engine, judged against JavaScript's `RegExp`.
//
// The oracle is exact for the subset implemented, and exact in a strong sense: JavaScript's
// regexes backtrack, so the *choice* a pattern makes among several possible matches is
// specified, not just whether one exists. `(a|ab)c` against "abc" has one answer and a
// leftmost-longest engine would give a different one. Capture positions are compared too, since
// that is where a backtracking engine's semantics actually live.
//
// Two restrictions, both because this matches bytes rather than code points:
//
//   - patterns and subjects are ASCII, so a `.` is one byte and one character alike;
//   - `\s` is the ASCII set, where JavaScript's also contains several Unicode spaces.
//
// Anything outside the implemented subset — backreferences, lookaround, flags, named groups — is
// rejected by `compile`, and the tests assert the rejection rather than skipping it.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/regex/test/probe.wac") as unknown as {
  exec(pattern: Uint8Array, input: Uint8Array, at: number): Int32Array;
  execFlags(pattern: Uint8Array, input: Uint8Array, at: number, ignoreCase: boolean): Int32Array;
  accepts(pattern: Uint8Array): boolean;
};

const enc = new TextEncoder();
const b = (s: string): Uint8Array => enc.encode(s);

/** `[start, end]` per group, or null for no match. Group 0 is the whole match. */
type Match = Array<[number, number] | null> | null;

const STATUS_REJECTED = -1;
const STATUS_BUDGET = -2;

function wac(pattern: string, input: string): Match | "rejected" | "budget" {
  const out = mod.exec(b(pattern), b(input), 0);
  if (out[0] === STATUS_REJECTED) return "rejected";
  if (out[0] === STATUS_BUDGET) return "budget";
  if (out[0] === 0) return null;
  const groups: Match = [];
  for (let i = 1; i + 1 < out.length; i += 2) {
    const s = out[i];
    const e = out[i + 1];
    groups.push(s < 0 || e < 0 ? null : [s, e]);
  }
  return groups;
}

function oracle(pattern: string, input: string): Match {
  const re = new RegExp(pattern);
  const m = re.exec(input);
  if (m === null) return null;
  const groups: Match = [[m.index, m.index + m[0].length]];
  // JavaScript reports capture *text*, not positions, without the `d` flag. `d` gives indices
  // directly and is what makes a position-level comparison possible at all.
  const withIndices = new RegExp(pattern, "d").exec(input) as RegExpExecArray & {
    indices?: Array<[number, number] | undefined>;
  };
  const idx = withIndices?.indices;
  if (idx === undefined) throw new Error("the runtime does not support the d flag");
  for (let i = 1; i < idx.length; i++) {
    const pair = idx[i];
    groups.push(pair === undefined ? null : [pair[0], pair[1]]);
  }
  groups[0] = idx[0] === undefined ? null : [idx[0][0], idx[0][1]];
  return groups;
}

function show(m: Match | "rejected" | "budget"): string {
  if (m === "rejected" || m === "budget" || m === null) return String(m);
  return "[" + m.map(g => g === null ? "-" : `${g[0]},${g[1]}`).join(" ") + "]";
}

function same(a: Match, b: Match): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === null || y === null) {
      if (x !== y) return false;
    } else if (x[0] !== y[0] || x[1] !== y[1]) return false;
  }
  return true;
}

/** Compare one (pattern, input), returning a complaint or null. */
function disagreement(pattern: string, input: string): string | null {
  const got = wac(pattern, input);
  if (got === "rejected") return `/${pattern}/ was rejected by the compiler`;
  if (got === "budget") return `/${pattern}/ on ${JSON.stringify(input)} ran out of steps`;
  const want = oracle(pattern, input);
  if (!same(got, want)) {
    return `/${pattern}/ on ${JSON.stringify(input)}: got ${show(got)}, RegExp says ${show(want)}`;
  }
  return null;
}

function checkAll(patterns: string[], inputs: string[]): void {
  const bad: string[] = [];
  let compared = 0;
  for (const p of patterns) {
    for (const s of inputs) {
      compared++;
      const d = disagreement(p, s);
      if (d !== null) bad.push(d);
    }
  }
  if (bad.length > 0) {
    throw new Error(`${bad.length}/${compared} disagreed:\n  ${bad.slice(0, 15).join("\n  ")}`);
  }
}

const SUBJECTS = [
  "", "a", "b", "ab", "ba", "aa", "abc", "abcabc", "aaa", "aaaa", "xay", "xaby",
  "a b", "  ", "a1b2", "123", "abc123", "_x_", "A", "aA", "\n", "a\nb", "-", "]", "[",
  "aaaaaaaaaa", "abababab", "cba", "cab", "xyz",
];

Deno.test("literals, dot and anchors", () => {
  checkAll([
    "a", "abc", "", "b", ".", "..", "a.c", ".*", "^a", "a$", "^a$", "^$", "^", "$",
    "^abc$", "a.b", "^.", ".$",
  ], SUBJECTS);
});

Deno.test("character classes", () => {
  checkAll([
    "[abc]", "[^abc]", "[a-c]", "[^a-c]", "[a-cx-z]", "[-a]", "[a-]", "[]]", "[^]]",
    "[0-9]", "[^0-9]", "[a-zA-Z]", "[\\n]", "[\\t]", "[.]", "[*]", "[a\\-c]",
    "[abc]+", "[^a]*", "[a-c][x-z]",
  ], SUBJECTS);
});

Deno.test("shorthand classes", () => {
  checkAll([
    "\\d", "\\D", "\\w", "\\W", "\\s", "\\S", "\\d+", "\\w+", "\\s+", "\\W\\w",
    "[\\d]", "[\\w]", "[\\d\\w]", "[\\da-f]", "\\d\\d\\d",
  ], SUBJECTS);
});

Deno.test("greedy quantifiers", () => {
  checkAll([
    "a*", "a+", "a?", "ab*", "ab+", "ab?", "a*b", "a+b", "a?b", ".*b", ".+b",
    "a{2}", "a{2,}", "a{2,3}", "a{0,2}", "a{0}", "a{1}", "a{3,3}", "(ab){2}", "(a|b){2,3}",
  ], SUBJECTS);
});

Deno.test("lazy quantifiers", () => {
  checkAll([
    "a*?", "a+?", "a??", "a*?b", "a+?b", ".*?b", ".+?b", "a{2,3}?", "a{0,2}?", "a{2,}?",
    "(ab)+?", "[abc]+?",
  ], SUBJECTS);
});

Deno.test("groups and alternation", () => {
  checkAll([
    "(a)", "(a)(b)", "(ab)", "(a|b)", "a|b", "a|b|c", "(a|ab)c", "(ab|a)c", "|a", "a|",
    "(?:a)", "(?:a|b)c", "((a))", "(a(b))", "(a)|(b)", "(a*)", "(a+)b", "(a|b)*",
    "(a)(b)?", "((a)|(b))c",
  ], SUBJECTS);
});

Deno.test("word boundaries", () => {
  checkAll([
    "\\ba", "a\\b", "\\ba\\b", "\\Ba", "a\\B", "\\babc\\b", "\\b", "\\B",
    "\\w+\\b", "\\b\\w",
  ], SUBJECTS);
});

Deno.test("the cases where backtracking order is the whole answer", () => {
  // A leftmost-longest engine gives different answers to every one of these, so agreeing here is
  // evidence about the search order and not merely about the language accepted.
  checkAll([
    "(a|ab)", "(a|ab)c", "(ab|a)", "(ab|a)b", "a*a", "(a*)(a*)", "(a+)(a*)",
    "(a?)(a?)a", ".*(b)", ".*?(b)", "(a*)*", "(a*)+", "(a|)*", "(|a)*",
  ], SUBJECTS);
});

Deno.test("empty-matching loops terminate and agree", () => {
  // The reason for the MARK/PROGRESS guard in the machine. Without it these do not terminate;
  // with a guard that is too eager they terminate with the wrong captures.
  checkAll([
    "(a*)*", "(a*)*b", "()*", "(){2,}", "(a?)*", "(a?)+", "()+", "(|a)+", "(a|)+b",
  ], ["", "a", "aa", "b", "ab", "aab"]);
});

Deno.test("patterns outside the subset are rejected, not mis-parsed", () => {
  // Each of these is valid JavaScript and unimplemented here. Rejecting is the honest answer;
  // the dangerous one is parsing it as something else — `(?=a)` as a group containing `?=a`.
  const bad: string[] = [];
  for (
    const p of [
      "(?=a)", "(?!a)", "(?<=a)", "(?<!a)", "(?<name>a)", "\\1", "(a)\\1",
      "*a", "+a", "?a", "(a", "a)", "[a", "[z-a]", "a{2,1}", "\\",
      "[\\D]", "[\\W]", "[\\S]",
    ]
  ) {
    if (mod.accepts(b(p))) bad.push(`/${p}/ was accepted and should not be`);
  }
  // And things that look similar but are in the subset.
  for (const p of ["(?:a)", "a{2,3}", "[a-z]", "\\d", "\\.", "\\\\", "a{,2}", "{2}"]) {
    if (!mod.accepts(b(p))) bad.push(`/${p}/ was rejected and should not be`);
  }
  if (bad.length > 0) throw new Error(bad.join("\n  "));
});

Deno.test("escapes of metacharacters", () => {
  checkAll([
    "\\.", "\\*", "\\+", "\\?", "\\(", "\\)", "\\[", "\\]", "\\|", "\\^", "\\$",
    "\\\\", "\\n", "\\t", "a\\.b", "\\.\\*",
  ], ["a.b", "a*b", "a+b", "a?b", "(", ")", "[", "]", "|", "^", "$", "\\", "\n", "\t", "abc"]);
});

/**
 * Patterns and subjects assembled from fragments, which is where the hand-written cases stop.
 *
 * Seeded, so a failure is reproducible. A pattern that the compiler rejects is not a
 * disagreement — the subset is documented — but one that JavaScript rejects and this accepts
 * would be, and is checked.
 */
function fuzz(seed: number, rounds: number, nested: boolean): void {
  const ATOMS = [
    "a", "b", "c", ".", "\\d", "\\w", "\\s", "[ab]", "[^a]", "[a-c]", "x", "1", "_",
    "(a)", "(a|b)", "(?:ab)", "\\.", "^", "$", "\\b",
  ];
  const QUANT = ["", "", "", "*", "+", "?", "*?", "+?", "??", "{2}", "{1,2}", "{0,2}", "{2,}"];
  let x = seed | 0;
  const next = (): number => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x;
  };
  const pick = <T>(xs: T[]): T => xs[next() % xs.length];

  const piece = (depth: number): string => {
    // A group containing an alternation of quantified pieces, which is where the wrapping and
    // the jump fixups interact — and where every bug in this engine so far has lived.
    if (nested && depth > 0 && next() % 4 === 0) {
      const branches = 1 + (next() % 3);
      let inner = "";
      for (let k = 0; k < branches; k++) {
        if (k > 0) inner += "|";
        const n = 1 + (next() % 2);
        for (let j = 0; j < n; j++) inner += piece(depth - 1);
      }
      return (next() % 2 === 0 ? "(" : "(?:") + inner + ")" + pick(QUANT);
    }
    return pick(ATOMS) + pick(QUANT);
  };

  const bad: string[] = [];
  let compared = 0;
  let rejected = 0;
  let gaveUp = 0;
  for (let i = 0; i < rounds; i++) {
    let pattern = "";
    const parts = 1 + (next() % 3);
    for (let k = 0; k < parts; k++) {
      pattern += piece(nested ? 2 : 0);
      if (next() % 6 === 0) pattern += "|";
    }
    let jsOk = true;
    try {
      new RegExp(pattern, "d");
    } catch {
      jsOk = false;
    }
    const accepted = mod.accepts(b(pattern));
    if (!jsOk) {
      if (accepted) bad.push(`/${pattern}/ is not a valid JavaScript regex but was accepted`);
      continue;
    }
    if (!accepted) {
      rejected++;
      continue;
    }
    const subject = pick(SUBJECTS);
    const got = wac(pattern, subject);
    if (got === "budget") {
      // Catastrophic backtracking, which is a documented outcome rather than a wrong answer:
      // `(a|a)*b` on a run of a's is exponential in any backtracking engine, JavaScript's
      // included. Counted so it cannot quietly become the common case.
      gaveUp++;
      continue;
    }
    compared++;
    const d = disagreement(pattern, subject);
    if (d !== null) bad.push(d);
  }
  if (bad.length > 0) {
    throw new Error(`seed ${seed}: ${bad.length}/${compared} disagreed:\n  ${bad.slice(0, 15).join("\n  ")}`);
  }
  // Rejections are counted rather than ignored: if a change started refusing most generated
  // patterns, every remaining comparison could pass while the test compared almost nothing.
  if (rejected > rounds * 0.15) {
    throw new Error(`seed ${seed}: the compiler refused ${rejected}/${rounds} patterns, too many to call this a comparison`);
  }
  if (gaveUp > rounds * 0.02) {
    throw new Error(`seed ${seed}: ${gaveUp}/${rounds} patterns exhausted the step budget, which is more than a pathological handful`);
  }
}

Deno.test("fuzz: flat patterns agree with RegExp", () => {
  fuzz(0x2f6a1b3c, 2000, false);
  fuzz(0x51d0c0de, 2000, false);
});

Deno.test("fuzz: nested groups and alternations agree with RegExp", () => {
  // Where the interesting bugs were: an alternation inside a quantified group, so the code that
  // gets wrapped already contains jumps of its own.
  fuzz(0x0badc0de, 2000, true);
  fuzz(0x7e577e57, 2000, true);
});

/**
 * The `i` flag, judged against `RegExp` with `"i"`.
 *
 * ASCII only, and that is a real limit rather than an oversight: this engine matches *bytes*, so
 * folding a non-ASCII letter would mean folding half of a multi-byte scalar. `packages/unicode`
 * has the full simple-fold table for a caller that works in code points; a code-point-aware
 * matcher is what would use it, and is not this.
 *
 * The subjects are ASCII for the same reason the rest of this file's are.
 */
function wacFlags(pattern: string, input: string, ignoreCase: boolean): Match | "rejected" | "budget" {
  const out = mod.execFlags(b(pattern), b(input), 0, ignoreCase);
  if (out[0] === STATUS_REJECTED) return "rejected";
  if (out[0] === STATUS_BUDGET) return "budget";
  if (out[0] === 0) return null;
  const groups: Match = [];
  for (let i = 1; i + 1 < out.length; i += 2) {
    const s = out[i];
    const e = out[i + 1];
    groups.push(s < 0 || e < 0 ? null : [s, e]);
  }
  return groups;
}

function oracleFlags(pattern: string, input: string): Match {
  const withIndices = new RegExp(pattern, "di").exec(input) as RegExpExecArray & {
    indices?: Array<[number, number] | undefined>;
  };
  if (withIndices === null) return null;
  const idx = withIndices.indices;
  if (idx === undefined) throw new Error("the runtime does not support the d flag");
  const groups: Match = [];
  for (let i = 0; i < idx.length; i++) {
    const pair = idx[i];
    groups.push(pair === undefined ? null : [pair[0], pair[1]]);
  }
  return groups;
}

Deno.test("the i flag agrees with RegExp over ASCII", () => {
  const patterns = [
    "a", "abc", "A", "ABC", "aBc", "[a-z]", "[A-Z]", "[a-cX-Z]", "[^a-z]", "[^A]",
    "a+", "A*", "(a|B)", "(?:ab)+", "a{2,3}", "\\ba\\b", "^abc$", "[a-z0-9_]+",
    "x[yz]", "(a)(B)?", "\\w+", "\\d[a-f]", "[-a-c]", "K", "k",
  ];
  const subjects = [
    "", "a", "A", "ab", "AB", "aB", "Ab", "abc", "ABC", "AbC", "xyz", "XYZ", "a1b2",
    "_x_", "ABCABC", "kK", "Kk", "zZ",
  ];
  const bad: string[] = [];
  for (const p of patterns) {
    for (const s of subjects) {
      const got = wacFlags(p, s, true);
      if (got === "rejected") {
        bad.push(`/${p}/i was rejected`);
        continue;
      }
      if (got === "budget") {
        bad.push(`/${p}/i on ${JSON.stringify(s)} ran out of steps`);
        continue;
      }
      const want = oracleFlags(p, s);
      if (!same(got, want)) {
        bad.push(`/${p}/i on ${JSON.stringify(s)}: got ${show(got)}, RegExp says ${show(want)}`);
      }
    }
  }
  if (bad.length > 0) {
    throw new Error(`${bad.length} disagreed:\n  ${bad.slice(0, 12).join("\n  ")}`);
  }
});

Deno.test("the i flag changes nothing when nothing is cased", () => {
  // A pattern with no letters must behave identically with and without the flag, which is the
  // cheapest check that the folding is confined to where it belongs.
  for (const p of ["\\d+", "[0-9]", "^$", "\\.", "[-_]", "1{2}", "(\\s)"]) {
    for (const s of ["", "1", "12", ".", "-", "_", " ", "a1"]) {
      const plain = show(wacFlags(p, s, false));
      const folded = show(wacFlags(p, s, true));
      if (plain !== folded) {
        throw new Error(`/${p}/ on ${JSON.stringify(s)}: ${plain} without i, ${folded} with`);
      }
    }
  }
});
