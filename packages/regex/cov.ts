// Branch coverage for regex.
//
// The same patterns the tests use, plus the generator, because the compiler's interesting
// branches are the quantifier shapes and the machine's are the opcodes — and only a wide pattern
// set reaches both.
//
//   deno task coverage:regex
//   deno task coverage:regex --verbose

import { instrument, report } from "../../harness/wacCoverage.ts";

const verbose = Deno.args.includes("--verbose");
const enc = new TextEncoder();

const run = await instrument("packages/regex/test/probe.wac");
const exec = run.mod.exec as (p: Uint8Array, s: Uint8Array, at: number) => Int32Array;
const accepts = run.mod.accepts as (p: Uint8Array) => boolean;

const SUBJECTS = [
  "", "a", "b", "ab", "ba", "aa", "abc", "abcabc", "aaa", "aaaa", "xay", "xaby",
  "a b", "  ", "a1b2", "123", "abc123", "_x_", "A", "aA", "\n", "a\nb", "-", "]", "[",
  "aaaaaaaaaa", "abababab", "cba", "cab", "xyz",
];

const PATTERNS = [
  "a", "abc", "", ".", "..", "a.c", ".*", "^a", "a$", "^a$", "^$", "^", "$", "^abc$",
  "[abc]", "[^abc]", "[a-c]", "[^a-c]", "[a-cx-z]", "[-a]", "[a-]", "[]]", "[^]]", "[]",
  "[0-9]", "[a-zA-Z]", "[\\n]", "[\\t]", "[.]", "[*]", "[a\\-c]", "[abc]+", "[^a]*",
  "\\d", "\\D", "\\w", "\\W", "\\s", "\\S", "\\d+", "[\\d]", "[\\w]", "[\\da-f]",
  "a*", "a+", "a?", "ab*", "a*b", ".*b", "a{2}", "a{2,}", "a{2,3}", "a{0,2}", "a{0}", "a{1}",
  "(ab){2}", "(a|b){2,3}", "a*?", "a+?", "a??", "a{2,3}?", "a{0,2}?", "a{2,}?", "(ab)+?",
  "(a)", "(a)(b)", "(a|b)", "a|b", "a|b|c", "(a|ab)c", "|a", "a|", "(?:a)", "((a))",
  "(a)|(b)", "(a*)", "(a|b)*", "((a)|(b))c", "\\ba", "a\\b", "\\Ba", "\\b", "\\B",
  "(a*)*", "(a*)+", "()*", "(){2,}", "(a?)*", "(a?)+", "()+", "(|a)+", "(a|)+b",
  "\\.", "\\*", "\\\\", "\\n", "\\t", "\\0", "\\f", "\\v", "\\r",
  "(?:(a)|b){2}", "(?:(a)|.*){2,}", "(a)(b)?", "\\d*\\d*?", "a(\\b|(a)?|b*){2}",
];

for (const p of PATTERNS) {
  for (const s of SUBJECTS) exec(enc.encode(p), enc.encode(s), 0);
}

/** Patterns the compiler must refuse, which is the only way to reach the failure paths. */
for (
  const p of [
    "(?=a)", "(?!a)", "(?<=a)", "(?<name>a)", "\\1", "(a)\\1", "*a", "+a", "?a", "(a", "a)",
    "[a", "[z-a]", "a{2,1}", "\\", "[\\D]", "[\\W]", "[\\S]", "^?", "$*", "\\b+", "[\\",
    "a{" + "9".repeat(4) + "}", "(a){500}{500}",
  ]
) accepts(enc.encode(p));

/**
 * The fuzzer's generator, kept in step with `test/fuzz` by hand.
 *
 * The hand-written list above covers the constructs; this covers their combinations, which is
 * where the quantifier wrapping and the jump fixups meet.
 */
{
  const ATOMS = [
    "a", "b", "c", ".", "\\d", "\\w", "\\s", "[ab]", "[^a]", "[a-c]", "x", "1", "_",
    "(a)", "(a|b)", "(?:ab)", "\\.", "^", "$", "\\b",
  ];
  const QUANT = ["", "", "", "*", "+", "?", "*?", "+?", "??", "{2}", "{1,2}", "{0,2}", "{2,}"];
  let x = 0x0badc0de | 0;
  const next = (): number => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x;
  };
  const pick = <T>(xs: T[]): T => xs[next() % xs.length];
  const piece = (depth: number): string => {
    if (depth > 0 && next() % 4 === 0) {
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
  for (let i = 0; i < 3000; i++) {
    let pattern = "";
    const parts = 1 + (next() % 3);
    for (let k = 0; k < parts; k++) {
      pattern += piece(2);
      if (next() % 6 === 0) pattern += "|";
    }
    exec(enc.encode(pattern), enc.encode(pick(SUBJECTS)), 0);
  }
}

/** A pattern that exhausts the step budget, which is its own return value. */
exec(enc.encode("(a|a|aa)+b"), enc.encode("a".repeat(40)), 0);

report([run], "packages/regex/", { verbose });
