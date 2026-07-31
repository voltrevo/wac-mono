// wac's u64 arithmetic, judged against BigInt.
//
// Every limb operation in this package leans on u64 behaving as an unsigned 64-bit
// integer: division and remainder above 2^63 must not be signed, `>> 32` must not sign-
// extend, and `as@ u32` must truncate. None of that is this package's code, so a bug
// there would show up as a wrong quotient somewhere deep in `divmod`.
//
// This file exists because that is exactly what happened: a division came out wrong, and
// ruling the compiler out first — in one run — is what made it clear the bug was in
// `divmod`'s own quotient estimate. Keeping the check means the next such question is
// already answered.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/bignum/test/u64_probe.wac") as unknown as {
  divU(a: bigint, b: bigint): bigint;
  remU(a: bigint, b: bigint): bigint;
  shrU(a: bigint, k: number): bigint;
  mulU(a: bigint, b: bigint): bigint;
  addU(a: bigint, b: bigint): bigint;
  subU(a: bigint, b: bigint): bigint;
  truncU32(a: bigint): number;
  geU(a: bigint, b: bigint): boolean;
  mulWide(x: number, y: number): bigint;
};

/** The probe takes i64 parameters, so a u64 travels as its two's complement pattern. */
const send = (v: bigint): bigint => BigInt.asIntN(64, v);
const recv = (v: bigint): bigint => BigInt.asUintN(64, v);

const VALUES = [
  0n,
  1n,
  2n,
  0xffffffffn,
  0x100000000n,
  // Either side of the signed boundary, which is where a signed opcode would show.
  (1n << 63n) - 1n,
  1n << 63n,
  (1n << 63n) + 1n,
  (1n << 64n) - 2n,
  (1n << 64n) - 1n,
  0xffffffff00000000n,
  0xfffffffffffffffen,
];

Deno.test("u64: division and remainder are unsigned", () => {
  for (const a of VALUES) {
    for (const b of VALUES) {
      if (b === 0n) continue;
      const q = recv(mod.divU(send(a), send(b)));
      if (q !== a / b) throw new Error(`${a} / ${b}: got ${q}, want ${a / b}`);
      const r = recv(mod.remU(send(a), send(b)));
      if (r !== a % b) throw new Error(`${a} % ${b}: got ${r}, want ${a % b}`);
    }
  }
});

Deno.test("u64: add, sub and mul wrap at 2^64", () => {
  const wrap = (v: bigint): bigint => BigInt.asUintN(64, v);
  for (const a of VALUES) {
    for (const b of VALUES) {
      const checks: Array<[string, bigint, bigint]> = [
        ["+", recv(mod.addU(send(a), send(b))), wrap(a + b)],
        ["-", recv(mod.subU(send(a), send(b))), wrap(a - b)],
        ["*", recv(mod.mulU(send(a), send(b))), wrap(a * b)],
      ];
      for (const [op, got, want] of checks) {
        if (got !== want) throw new Error(`${a} ${op} ${b}: got ${got}, want ${want}`);
      }
    }
  }
});

Deno.test("u64: >> does not sign-extend", () => {
  for (const a of VALUES) {
    for (const k of [0, 1, 31, 32, 33, 63]) {
      const got = recv(mod.shrU(send(a), k));
      const want = a >> BigInt(k);
      if (got !== want) throw new Error(`${a} >> ${k}: got ${got}, want ${want}`);
    }
  }
});

Deno.test("u64: comparison is unsigned", () => {
  for (const a of VALUES) {
    for (const b of VALUES) {
      const got = mod.geU(send(a), send(b));
      if (got !== (a >= b)) throw new Error(`${a} >= ${b}: got ${got}`);
    }
  }
});

Deno.test("u64: as@ u32 keeps the low 32 bits", () => {
  for (const a of VALUES) {
    const got = BigInt(mod.truncU32(send(a)) >>> 0);
    const want = a & 0xffffffffn;
    if (got !== want) throw new Error(`trunc ${a}: got ${got}, want ${want}`);
  }
});

Deno.test("u64: u32 * u32 widens without overflow", () => {
  // The shape the multiply-subtract inner loop uses. If this narrowed, every product of
  // two large limbs would be wrong.
  for (const x of [0, 1, -1, -2, 0x7fffffff, 0xffff, 0x10000]) {
    for (const y of [0, 1, -1, -2, 0x7fffffff, 0xffff]) {
      const got = recv(mod.mulWide(x, y));
      const want = BigInt(x >>> 0) * BigInt(y >>> 0);
      if (got !== want) throw new Error(`${x >>> 0} * ${y >>> 0}: got ${got}, want ${want}`);
    }
  }
});
