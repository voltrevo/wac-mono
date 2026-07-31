// The bignum against the host's BigInt.
//
// This is where the arithmetic underneath ftoa is actually verified. A wrong carry
// or a mis-normalised limb count would not necessarily show up as a wrong string —
// it would show up as one digit too many, which is exactly how the first version's
// bug presented, and by then the cause is several layers down.

import { wacBind } from "../../../harness/wacBind.ts";

const m = await wacBind("packages/fmt/test/bigops.wac") as unknown as {
  shiftTest(v: bigint, bits: number): Uint8Array;
  mulTest(v: bigint, bits: number, mul: number, times: number): Uint8Array;
  sumTest(a: bigint, ashift: number, b: bigint, bshift: number): Uint8Array;
  subTest(a: bigint, ashift: number, b: bigint, bshift: number): Uint8Array;
  cmpTest(a: bigint, ashift: number, b: bigint, bshift: number): number;
};

/** Rebuild the exact value from the little-endian limb bytes. */
function toBig(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

function assertEq(got: bigint | number, want: bigint | number, what: string): void {
  if (got !== want) throw new Error(`${what}: got ${got}, want ${want}`);
}

Deno.test("FixedBig: shiftLeft across every limb boundary", () => {
  // 31/32/33 is where a word-shift plus a bit-shift interact, which is the part
  // that is easy to get wrong and impossible to notice from a length check.
  const shifts = [0, 1, 7, 31, 32, 33, 63, 64, 65, 95, 96, 127, 200, 500, 971, 1074];
  const values = [1n, 3n, 0xFFn, 0xFFFFFFFFn, 0x100000000n, 0x1FFFFFFFFFFFFFn, 0xFFFFFFFFFFFFFFFFn];
  for (const v of values) {
    for (const s of shifts) {
      assertEq(toBig(m.shiftTest(v, s)), v << BigInt(s), `${v} << ${s}`);
    }
  }
});

Deno.test("FixedBig: mulSmall carries through many multiplications", () => {
  // Repeated ×10 is what the scaling and digit loops do, up to ~340 times for a
  // subnormal, so the carry chain has to hold over a long run.
  for (const [v, bits, mul, times] of [
    [1n, 0, 10, 1], [1n, 0, 10, 19], [1n, 0, 10, 340],
    [3n, 52, 10, 17], [0x1FFFFFFFFFFFFFn, 52, 10, 17],
    [0xFFFFFFFFFFFFFFFFn, 0, 10, 30], [1n, 100, 4, 3], [7n, 0, 2, 100],
  ] as [bigint, number, number, number][]) {
    assertEq(
      toBig(m.mulTest(v, bits, mul, times)),
      (v << BigInt(bits)) * BigInt(mul) ** BigInt(times),
      `(${v} << ${bits}) * ${mul}^${times}`,
    );
  }
});

Deno.test("FixedBig: random add, subtract and compare agree with BigInt", () => {
  let seed = 0x5bd1e995;
  const next = (): number => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;  seed >>>= 0;
    return seed;
  };
  const rand64 = (): bigint => (BigInt(next()) << 32n) | BigInt(next());

  for (let i = 0; i < 4000; i++) {
    const a = rand64(), b = rand64();
    const as_ = next() % 600, bs = next() % 600;
    const x = a << BigInt(as_), y = b << BigInt(bs);

    assertEq(toBig(m.sumTest(a, as_, b, bs)), x + y, `${x} + ${y}`);

    // sub requires the minuend to be the larger, which is the contract.
    if (x >= y) {
      assertEq(toBig(m.subTest(a, as_, b, bs)), x - y, `${x} - ${y}`);
    } else {
      assertEq(toBig(m.subTest(b, bs, a, as_)), y - x, `${y} - ${x}`);
    }

    const want = x < y ? -1 : x > y ? 1 : 0;
    assertEq(m.cmpTest(a, as_, b, bs), want, `cmp(${x}, ${y})`);
  }
});

Deno.test("FixedBig: subtraction that borrows across many zero limbs", () => {
  // 2^n - 1 turns every limb below the top into 0xFFFFFFFF, so the borrow has to
  // run the whole length. An off-by-one in the borrow shows up here and nowhere
  // else.
  for (const bits of [32, 33, 64, 96, 128, 500, 1024]) {
    assertEq(toBig(m.subTest(1n, bits, 1n, 0)), (1n << BigInt(bits)) - 1n, `2^${bits} - 1`);
  }
});

Deno.test("FixedBig: zero and equality edge cases", () => {
  assertEq(toBig(m.sumTest(0n, 0, 0n, 0)), 0n, "0 + 0");
  assertEq(toBig(m.subTest(5n, 0, 5n, 0)), 0n, "5 - 5 normalises to zero");
  assertEq(m.cmpTest(0n, 0, 0n, 0), 0, "0 == 0");
  assertEq(m.cmpTest(1n, 0, 0n, 0), 1, "1 > 0");
  assertEq(m.cmpTest(0n, 0, 1n, 0), -1, "0 < 1");
  // The same magnitude reached two ways: 2^32 shifted 32, and 1 shifted 64. Both
  // operands stay inside u64, and they compare equal only if the limb count is
  // normalised after every operation.
  assertEq(m.cmpTest(0x100000000n, 32, 1n, 64), 0, "2^64 == 2^64");
  assertEq(m.cmpTest(0xFFFFFFFFFFFFFFFFn, 0, 1n, 64), -1, "2^64 - 1 < 2^64");
});
