// `test/wac/flat.wac` is an experiment about a *language* feature, not about this package, and it
// would rot in a week without something compiling it. This test does not time anything — the
// timings are in `test/wac/flat.wac`'s header and were taken by hand — it only checks that the
// three representations still compute the same Montgomery multiplication and addition.
//
// That check is the load-bearing part of the experiment. Three implementations that disagree can
// be timed against each other all day and the comparison means nothing, and the fastest way to
// make a flat representation look good is to get its carry handling subtly wrong.

import { wacBind } from "../../../harness/wacBind.ts";

const flat = await wacBind("packages/bls/test/wac/flat.wac") as unknown as {
  chainA(seed: Uint32Array, n: number): Uint8Array;
  chainB(seed: Uint32Array, n: number): Uint8Array;
  chainC(seed: Uint32Array, n: number): Uint8Array;
  chainAddA(seed: Uint32Array, n: number): Uint8Array;
  chainAddC(seed: Uint32Array, n: number): Uint8Array;
};

const hex = (b: Uint8Array) =>
  Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

// Twelve words below p. A dependent chain of squarings from here walks through values with no
// particular structure, which is what exercises the conditional-subtraction and carry paths.
const seed = new Uint32Array([
  0x12345677, 0x9abcdef0, 0x11223344, 0x55667788,
  0xdeadbeef, 0x01020304, 0x0a0b0c0d, 0x10203040,
  0x00ff00ff, 0x13571357, 0x2468ace0, 0x0a0111ea,
]);

Deno.test("the three multiplication representations agree over a long chain", () => {
  const a = hex(flat.chainA(seed, 200));
  const b = hex(flat.chainB(seed, 200));
  const c = hex(flat.chainC(seed, 200));
  if (a !== b) throw new Error(`hoisted-temporaries differs from allocating\n  A ${a}\n  B ${b}`);
  if (a !== c) throw new Error(`flat differs from allocating\n  A ${a}\n  C ${c}`);
});

Deno.test("the addition representations agree over a long chain", () => {
  const a = hex(flat.chainAddA(seed, 500));
  const c = hex(flat.chainAddC(seed, 500));
  if (a !== c) throw new Error(`flat addition differs from allocating\n  A ${a}\n  C ${c}`);
});
