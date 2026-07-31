// Structural tests on the Huffman builder, via test/probe/huffman_probe.wac.
//
// Fibonacci frequencies are used throughout because they are the worst case for
// code length — each weight is the sum of the two below it, so the tree
// degenerates into a chain. That makes them the natural way to exercise the
// 15-bit limit that DEFLATE imposes and that a plain Huffman build violates.

import { wacBind } from "../harness/wacBind.ts";

const mod = await wacBind("test/probe/huffman_probe.wac");
const fibMaxLen = mod.fibMaxLen as (count: number, maxBits: number) => number;
const fibKraft = mod.fibKraft as (count: number, maxBits: number) => number;
const fibKraftTarget = mod.fibKraftTarget as (count: number, maxBits: number) => number;
const fibPrefixViolations = mod.fibPrefixViolations as (count: number, maxBits: number) => number;
const fibOverlongCodes = mod.fibOverlongCodes as (count: number, maxBits: number) => number;

Deno.test("huffman: Fibonacci frequencies genuinely need length limiting", () => {
  // Built with a limit high enough not to bind, depth must exceed 15 — otherwise
  // the tests below would pass without the limiting code ever running.
  const unlimited = fibMaxLen(40, 30);
  if (unlimited <= 15) {
    throw new Error(`expected an unlimited build over 15 bits, got ${unlimited} — ` +
      `this input no longer exercises the limiter`);
  }
});

Deno.test("huffman: the 15-bit limit is enforced", () => {
  for (const count of [2, 3, 8, 20, 30, 40, 60, 100, 286]) {
    const got = fibMaxLen(count, 15);
    if (got > 15) throw new Error(`count ${count}: max length ${got} exceeds 15`);
    if (got < 1) throw new Error(`count ${count}: max length ${got} is not a code`);
  }
});

Deno.test("huffman: the 7-bit limit is enforced (code-length alphabet)", () => {
  for (const count of [2, 5, 10, 19]) {
    const got = fibMaxLen(count, 7);
    if (got > 7) throw new Error(`count ${count}: max length ${got} exceeds 7`);
  }
});

Deno.test("huffman: codes satisfy Kraft equality — complete, not over-subscribed", () => {
  // sum of 2^(maxLen-len) == 2^maxLen exactly. Under means some bit patterns
  // decode to nothing; over means two symbols share a pattern.
  for (const maxBits of [7, 15, 30]) {
    for (const count of [2, 3, 8, 19, 20, 40, 100, 286]) {
      if (maxBits === 7 && count > 19) continue;
      const got = fibKraft(count, maxBits);
      const want = fibKraftTarget(count, maxBits);
      if (got !== want) {
        throw new Error(`count ${count}, maxBits ${maxBits}: Kraft sum ${got}, expected ${want}` +
          (got < want ? " (incomplete code)" : " (over-subscribed code)"));
      }
    }
  }
});

Deno.test("huffman: canonical codes form a real prefix code", () => {
  for (const count of [2, 3, 8, 20, 40, 100, 286]) {
    const bad = fibPrefixViolations(count, 15);
    if (bad !== 0) throw new Error(`count ${count}: ${bad} prefix violations`);
  }
});

Deno.test("huffman: no code exceeds the width its length claims", () => {
  for (const count of [2, 3, 8, 20, 40, 100, 286]) {
    const bad = fibOverlongCodes(count, 15);
    if (bad !== 0) throw new Error(`count ${count}: ${bad} codes wider than their length`);
  }
});
