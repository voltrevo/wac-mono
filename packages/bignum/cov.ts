// Branch coverage for bignum.
//
// The exercises are the ones the test suite runs, on purpose: coverage measured against a
// workload the tests do not use tells you about that workload rather than about the tests.
// So the generators here mirror `test/arith.test.ts` — including the all-ones and
// all-zeros limb runs, which is the family that found the quotient-estimate bug and which
// random operands never reach.
//
//   deno task coverage:bignum
//   deno task coverage:bignum --verbose

import { instrument, report } from "../../harness/wacCoverage.ts";

const verbose = Deno.args.includes("--verbose");
const enc = new TextEncoder();

const run = await instrument("packages/bignum/test/probe.wac");
const call2 = (name: string) =>
  (x: bigint, y: bigint) =>
    (run.mod[name] as (a: Uint8Array, b: Uint8Array) => Uint8Array)(
      enc.encode(x.toString()),
      enc.encode(y.toString()),
    );
const opAdd = call2("opAdd");
/** The same export, but taking raw bytes, so malformed input can reach the reject path. */
const opAdd_raw = run.mod.opAdd as (a: Uint8Array, b: Uint8Array) => Uint8Array;
const opSub = call2("opSub");
const opMul = call2("opMul");
const opDiv = call2("opDiv");
const opRem = call2("opRem");
const opCmp = call2("opCmp");
const opCmpAbs = call2("opCmpAbs");
const one = (name: string) =>
  (x: bigint) => (run.mod[name] as (a: Uint8Array) => unknown)(enc.encode(x.toString()));
const opNeg = one("opNeg");
const opAbs = one("opAbs");
const opCopy = one("opCopy");
const opBitLen = one("opBitLen");
const opIsZero = one("opIsZero");
const toHex = one("toHex");
const opShl = run.mod.opShl as (a: Uint8Array, k: number) => Uint8Array;
const opShr = run.mod.opShr as (a: Uint8Array, k: number) => Uint8Array;
const opMulSmall = run.mod.opMulSmall as (a: Uint8Array, m: number) => Uint8Array;
const opDivSmall = run.mod.opDivSmall as (a: Uint8Array, m: number) => Uint8Array;
const opRemSmall = run.mod.opRemSmall as (a: Uint8Array, m: number) => number;
const acceptsDecimal = run.mod.acceptsDecimal as (s: Uint8Array) => boolean;
const acceptsHex = run.mod.acceptsHex as (s: Uint8Array) => boolean;
const fromHex = run.mod.fromHex as (s: Uint8Array) => Uint8Array;
const fromI64 = run.mod.fromI64 as (v: bigint) => Uint8Array;
const fromU64 = run.mod.fromU64 as (v: bigint) => Uint8Array;

function makeRng(seed: number): () => number {
  let x = seed | 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x;
  };
}

function randomBits(next: () => number, bits: number): bigint {
  if (bits <= 0) return 0n;
  let v = 1n;
  let have = 1;
  while (have < bits) {
    const take = Math.min(32, bits - have);
    v = (v << BigInt(take)) | BigInt(next() >>> (32 - take));
    have += take;
  }
  return v;
}

const both = (x: bigint, y: bigint): void => {
  opAdd(x, y);
  opSub(x, y);
  opMul(x, y);
  opCmp(x, y);
  opCmpAbs(x, y);
  if (y !== 0n) {
    opDiv(x, y);
    opRem(x, y);
  }
};

/** Small and signed, which is where the sign rules and the |a| < |b| early return live. */
for (let x = -40n; x <= 40n; x++) {
  for (let y = -40n; y <= 40n; y++) both(x, y);
}

/** Limb boundaries on both operands, where a carry grows a limb and a borrow sheds one. */
const anchors: bigint[] = [];
for (const p of [0, 1, 31, 32, 33, 63, 64, 65, 95, 96, 97, 128, 192]) anchors.push(1n << BigInt(p));
const boundary: bigint[] = [];
for (const a of anchors) for (let d = -2n; d <= 2n; d++) if (a + d >= 0n) boundary.push(a + d);
for (const x of boundary) {
  for (const y of boundary) {
    both(x, y);
    both(-x, y);
    both(x, -y);
    both(-x, -y);
  }
}

/**
 * All-ones and all-zeros limb runs.
 *
 * The family that reaches the quotient-estimate clamp and the add-back — a carry that
 * propagates the whole length of a value, and a divisor whose top limb is 0xffffffff.
 * Random digits essentially never produce either.
 */
const runs: bigint[] = [];
for (const limbs of [1, 2, 3, 4, 8, 17]) {
  const ones = (1n << BigInt(32 * limbs)) - 1n;
  runs.push(ones, ones - 1n, ones + 1n, 1n << BigInt(32 * limbs));
  let alt = 0n;
  for (let i = 0; i < limbs; i++) alt = (alt << 32n) | (i % 2 === 0 ? 0xffffffffn : 0n);
  if (alt > 0n) runs.push(alt);
}
for (const x of runs) {
  for (const y of runs) {
    both(x, y);
    both(-x, y);
    both(x, -y);
  }
}

/** Divisors shaped to need the add-back, and dividends that are exact multiples. */
{
  const next = makeRng(0x51de51de);
  for (const limbs of [2, 3, 4]) {
    for (const top of [0x80000000n, 0xffffffffn]) {
      for (const rest of [0n, 0xffffffffn]) {
        let d = top;
        for (let i = 1; i < limbs; i++) d = (d << 32n) | rest;
        for (let t = 0; t < 6; t++) {
          const q = randomBits(next, 1 + (next() % 130));
          for (const delta of [-1n, 0n, 1n]) {
            const a = q * d + delta;
            if (a < 0n) continue;
            both(a, d);
            both(-a, d);
          }
        }
      }
    }
  }
}

/** Random operands with independently chosen sizes, so limb counts usually differ. */
{
  const next = makeRng(0x0badc0de);
  for (let t = 0; t < 200; t++) {
    const x = randomBits(next, 1 + (next() % 400));
    const y = randomBits(next, 1 + (next() % 400));
    both((next() & 1) === 1 ? -x : x, (next() & 1) === 1 ? -y : y);
  }
}

/** Shifts, both directions, negative counts, and past the whole width. */
for (const mag of [0n, 1n, 5n, 0xffffffffn, 1n << 100n, (1n << 200n) - 1n]) {
  for (const v of [mag, -mag]) {
    const b = enc.encode(v.toString());
    for (const k of [0, 1, 31, 32, 33, 96, 200, 500, -1, -32, -70]) {
      opShl(b, k);
      opShr(b, k);
    }
  }
}

/** The single-limb paths, including a zero multiplier and the top of the u32 range. */
for (const mag of [0n, 1n, (1n << 100n) + 7n]) {
  for (const v of [mag, -mag]) {
    const b = enc.encode(v.toString());
    for (const m of [0, 1, 2, 10, 1000000000, -1, -2]) {
      opMulSmall(b, m);
      if (m !== 0) {
        opDivSmall(b, m);
        opRemSmall(b, m);
      }
    }
  }
}

/** Division by zero, which traps — the trap is the branch. */
for (const x of [0n, 1n, 1n << 200n]) {
  try {
    opDiv(x, 0n);
  } catch { /* expected */ }
  try {
    opRemSmall(enc.encode(x.toString()), 0);
  } catch { /* expected */ }
}

/** The unary operations and the predicates. */
for (const mag of [0n, 1n, 0xffffffffn, (1n << 300n) - 1n]) {
  for (const v of [mag, -mag]) {
    opNeg(v);
    opAbs(v);
    opCopy(v);
    opBitLen(v);
    opIsZero(v);
    toHex(v);
  }
}

/** Text: accepted, rejected, and both hex spellings. */
for (
  const s of [
    "0", "-0", "+0", "007", "-12345", "1".repeat(40),
    "", "-", "+", "abc", "1.5", "1e5", " 1", "1,000", "1x", "1".repeat(9) + "x",
    "1".repeat(18) + "x",
  ]
) acceptsDecimal(enc.encode(s));

for (const s of ["0", "ff", "FF", "0xff", "0XFF", "-0xff", "", "-", "0x", "g", "0xg"]) {
  acceptsHex(enc.encode(s));
}
for (const s of ["0", "ff", "0xFF", "-0xff", "f".repeat(20)]) fromHex(enc.encode(s));

/** The integer constructors, including the most negative i64. */
for (const v of [0n, 1n, -1n, 1n << 32n, (1n << 63n) - 1n, -(1n << 63n)]) fromI64(v);
for (const v of [0n, 1n, (1n << 64n) - 1n]) fromU64(BigInt.asIntN(64, v));

/** The round-trip export, and the probe's own reject paths, which trap by design. */
for (const v of [0n, -1n, (1n << 300n) + 5n]) {
  (run.mod.roundTrip as (s: Uint8Array) => Uint8Array)(enc.encode(v.toString()));
}
for (const bad of ["", "1.5", "-"]) {
  try {
    opAdd_raw(enc.encode(bad), enc.encode("1"));
  } catch { /* the trap is the branch */ }
  try {
    fromHex(enc.encode(bad === "" ? "" : "zz"));
  } catch { /* likewise */ }
}

/**
 * The wac-written tests are a second entry point.
 *
 * `toStr` returns a `string`, so it is only reachable from wac — a report over the
 * host-facing probe alone shows it dead when it is in fact tested.
 */
const testRun = await instrument("packages/bignum/test/wac/big_test.wac");
for (const [name, fn] of Object.entries(testRun.mod)) {
  if (!name.startsWith("test") || typeof fn !== "function") continue;
  const failure = (fn as () => string)();
  if (failure !== "") throw new Error(`${name} failed during coverage: ${failure}`);
}

report([run, testRun], "packages/bignum/", { verbose });
