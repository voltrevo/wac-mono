// Arbitrary-precision arithmetic, judged against BigInt.
//
// BigInt is an exact oracle, so nothing here inspects output or argues about what the
// right answer is: every case is a comparison. That is the whole reason this package was
// worth writing — correctness is decidable.
//
// The generators are deliberately biased toward the shapes that break bignums:
//
//   - operands whose limb counts differ, and differ by a lot
//   - values just below and just above a limb boundary, where a carry or borrow
//     propagates the whole way and `n` changes
//   - divisors whose top limb is large, which is where a quotient-digit estimate is
//     most likely to come out one too high and need the add-back
//   - long runs of 0xffffffff and of 0x00000000 limbs, which random digits never produce

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/bignum/test/probe.wac") as unknown as {
  opAdd(a: Uint8Array, b: Uint8Array): Uint8Array;
  opSub(a: Uint8Array, b: Uint8Array): Uint8Array;
  opMul(a: Uint8Array, b: Uint8Array): Uint8Array;
  opDiv(a: Uint8Array, b: Uint8Array): Uint8Array;
  opRem(a: Uint8Array, b: Uint8Array): Uint8Array;
  opNeg(a: Uint8Array): Uint8Array;
  opAbs(a: Uint8Array): Uint8Array;
  opCopy(a: Uint8Array): Uint8Array;
  opShl(a: Uint8Array, bits: number): Uint8Array;
  opShr(a: Uint8Array, bits: number): Uint8Array;
  opMulSmall(a: Uint8Array, m: number): Uint8Array;
  opDivSmall(a: Uint8Array, m: number): Uint8Array;
  opRemSmall(a: Uint8Array, m: number): number;
  opCmp(a: Uint8Array, b: Uint8Array): number;
  opCmpAbs(a: Uint8Array, b: Uint8Array): number;
};

const enc = new TextEncoder();
const dec = new TextDecoder();
const b = (v: bigint): Uint8Array => enc.encode(v.toString());
const s = (u: Uint8Array): string => dec.decode(u);

type Op = {
  name: string;
  wac: (x: bigint, y: bigint) => string;
  js: (x: bigint, y: bigint) => bigint;
  /** Division and remainder cannot take a zero right-hand side. */
  needsNonZero?: boolean;
};

const OPS: Op[] = [
  { name: "add", wac: (x, y) => s(mod.opAdd(b(x), b(y))), js: (x, y) => x + y },
  { name: "sub", wac: (x, y) => s(mod.opSub(b(x), b(y))), js: (x, y) => x - y },
  { name: "mul", wac: (x, y) => s(mod.opMul(b(x), b(y))), js: (x, y) => x * y },
  { name: "div", wac: (x, y) => s(mod.opDiv(b(x), b(y))), js: (x, y) => x / y, needsNonZero: true },
  { name: "rem", wac: (x, y) => s(mod.opRem(b(x), b(y))), js: (x, y) => x % y, needsNonZero: true },
];

function checkAll(pairs: Array<[bigint, bigint]>, label: string): void {
  for (const [x, y] of pairs) {
    for (const op of OPS) {
      if (op.needsNonZero && y === 0n) continue;
      const want = op.js(x, y).toString();
      const got = op.wac(x, y);
      if (got !== want) {
        throw new Error(`${label}: ${x} ${op.name} ${y}\n  got  ${got}\n  want ${want}`);
      }
    }
  }
}

function makeRng(seed: number): () => number {
  let x = seed | 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x;
  };
}

/** A random value of exactly `bits` bits — the top bit is set, so the size is honest. */
function randomBits(next: () => number, bits: number): bigint {
  if (bits <= 0) return 0n;
  let v = 1n;
  let have = 1;
  while (have < bits) {
    const take = Math.min(32, bits - have);
    const word = BigInt(next() >>> (32 - take));
    v = (v << BigInt(take)) | word;
    have += take;
  }
  return v;
}

const withSigns = (x: bigint, y: bigint): Array<[bigint, bigint]> => [
  [x, y],
  [-x, y],
  [x, -y],
  [-x, -y],
];

Deno.test("arith: exhaustive over small values", () => {
  // Small and signed, where every carry, borrow and sign rule is reachable by hand.
  const pairs: Array<[bigint, bigint]> = [];
  for (let x = -40n; x <= 40n; x++) {
    for (let y = -40n; y <= 40n; y++) pairs.push([x, y]);
  }
  checkAll(pairs, "small");
});

Deno.test("arith: limb boundaries", () => {
  // Around every limb edge, on both operands independently: this is where an addition
  // grows a limb, a subtraction sheds one, and `n` is easiest to get wrong.
  const anchors: bigint[] = [];
  for (const p of [0, 1, 15, 16, 31, 32, 33, 63, 64, 65, 95, 96, 97, 127, 128, 129, 160, 192]) {
    anchors.push(1n << BigInt(p));
  }
  const values: bigint[] = [];
  for (const a of anchors) {
    for (let d = -2n; d <= 2n; d++) if (a + d >= 0n) values.push(a + d);
  }

  const pairs: Array<[bigint, bigint]> = [];
  for (const x of values) {
    for (const y of values) pairs.push(...withSigns(x, y));
  }
  checkAll(pairs, "boundary");
});

Deno.test("arith: all-ones and all-zeros limb runs", () => {
  // Random digits essentially never produce a run of 0xffffffff limbs, which is what
  // makes a carry propagate the whole length of a value, or a run of zero limbs, which
  // is what makes a borrow do the same.
  const values: bigint[] = [];
  for (const limbs of [1, 2, 3, 4, 8, 17]) {
    const ones = (1n << BigInt(32 * limbs)) - 1n;
    values.push(ones, ones - 1n, ones + 1n);
    // A high limb, then nothing: 0x00000001_00000000_00000000...
    values.push(1n << BigInt(32 * limbs));
    values.push((1n << BigInt(32 * limbs)) + 1n);
    // Alternating limbs, which random values also under-produce.
    let alt = 0n;
    for (let i = 0; i < limbs; i++) alt = (alt << 32n) | (i % 2 === 0 ? 0xffffffffn : 0n);
    if (alt > 0n) values.push(alt);
  }

  const pairs: Array<[bigint, bigint]> = [];
  for (const x of values) {
    for (const y of values) pairs.push(...withSigns(x, y));
  }
  checkAll(pairs, "runs");
});

Deno.test("arith: random operands across a wide size range", () => {
  const next = makeRng(0x0badc0de);
  const pairs: Array<[bigint, bigint]> = [];
  // Sizes chosen independently, so mismatched limb counts are the common case rather
  // than the exception — including the |a| < |b| early return in divmod.
  for (let t = 0; t < 400; t++) {
    const xb = 1 + (next() % 400);
    const yb = 1 + (next() % 400);
    const x = randomBits(next, xb);
    const y = randomBits(next, yb);
    pairs.push([
      (next() & 1) === 1 ? -x : x,
      (next() & 1) === 1 ? -y : y,
    ]);
  }
  checkAll(pairs, "random");
});

Deno.test("arith: divisors engineered to need the add-back", () => {
  // Knuth's algorithm D estimates a quotient digit from the top two limbs; after the
  // refinement loop the estimate can still be one too high, and only then does the
  // add-back run. The estimate is worst when the divisor's leading limbs are just below
  // a power of two, so build divisors of exactly that shape and dividends around
  // multiples of them.
  const next = makeRng(0x51de51de);
  const pairs: Array<[bigint, bigint]> = [];
  for (const limbs of [2, 3, 4, 6]) {
    for (const top of [0x80000000n, 0x80000001n, 0xfffffffen, 0xffffffffn]) {
      for (const restPattern of [0n, 0xffffffffn, 1n]) {
        let d = top;
        for (let i = 1; i < limbs; i++) d = (d << 32n) | restPattern;
        for (let t = 0; t < 12; t++) {
          const q = randomBits(next, 1 + (next() % 130));
          // A dividend that is an exact multiple, and its immediate neighbours: an exact
          // multiple is where an over-estimate has no slack to absorb it.
          for (const delta of [-2n, -1n, 0n, 1n, 2n]) {
            const a = q * d + delta;
            if (a < 0n) continue;
            pairs.push([a, d], [-a, d], [a, -d], [-a, -d]);
          }
        }
      }
    }
  }
  checkAll(pairs, "add-back");
});

Deno.test("arith: the quotient estimate survives rhat reaching base", () => {
  // Regression. When the first estimate comes out at exactly `base` it is clamped to
  // base-1, and the recomputed rhat can then be exactly base. The refinement test forms
  // base*rhat, which at that point is 2^64 and wraps a u64 to zero — so the test compared
  // against nothing and talked the estimate down by one, losing 2^32 from the quotient.
  //
  // Reaching it needs a divisor whose top limb is 0xffffffff and a remainder window just
  // above it, which is why 400 random pairs never did. The all-ones generator found it.
  const cases: Array<[bigint, bigint]> = [
    [
      0xffffffff00000000ffffffff00000000ffffffff0000000000000000n,
      0xfffffffffffffffffffffffen,
    ],
    [
      0xffffffff00000000ffffffff00000000ffffffff00000000ffffffff00000000n,
      0xfffffffffffffffffffffffen,
    ],
  ];
  // And a sweep of the same shape, so a variant of the mistake is caught too.
  for (const lowD of [0xfffffffen, 0xffffffffn, 0x00000000n, 0x00000001n]) {
    const d = (0xffffffffn << 64n) | (0xffffffffn << 32n) | lowD;
    for (const hi of [0xffffffffn, 0xfffffffen, 0x80000000n]) {
      for (const mid of [0n, 1n, 0xffffffffn]) {
        const a = (hi << 128n) | (mid << 96n) | (0xffffffffn << 64n) | 1n;
        cases.push([a, d]);
      }
    }
  }
  checkAll(cases, "estimate-clamp");
});

Deno.test("arith: division identity holds", () => {
  // a == q*b + r, and |r| < |b|, and r has the sign of a. Checked independently of the
  // per-operation comparison, because it constrains q and r *together*.
  const next = makeRng(0x7e577e57);
  for (let t = 0; t < 600; t++) {
    const ab = 1 + (next() % 300);
    const bb = 1 + (next() % 300);
    let a = randomBits(next, ab);
    let d = randomBits(next, bb);
    if (d === 0n) d = 1n;
    if ((next() & 1) === 1) a = -a;
    if ((next() & 1) === 1) d = -d;

    const q = BigInt(s(mod.opDiv(b(a), b(d))));
    const r = BigInt(s(mod.opRem(b(a), b(d))));
    if (q * d + r !== a) throw new Error(`identity: ${a} / ${d} gave q=${q} r=${r}`);
    const absR = r < 0n ? -r : r;
    const absD = d < 0n ? -d : d;
    if (absR >= absD) throw new Error(`remainder too large: ${a} / ${d} gave r=${r}`);
    if (r !== 0n && (r < 0n) !== (a < 0n)) {
      throw new Error(`remainder sign: ${a} / ${d} gave r=${r}`);
    }
  }
});

Deno.test("arith: truncated division matches BigInt on every sign", () => {
  // The textbook trap: -7/2 is -3 remainder -1 (truncated), not -4 remainder 1
  // (floored). Spelled out rather than left to the random sweep.
  const cases: Array<[bigint, bigint, bigint, bigint]> = [
    [7n, 2n, 3n, 1n],
    [-7n, 2n, -3n, -1n],
    [7n, -2n, -3n, 1n],
    [-7n, -2n, 3n, -1n],
    [1n, 3n, 0n, 1n],
    [-1n, 3n, 0n, -1n],
  ];
  for (const [x, y, wq, wr] of cases) {
    const q = s(mod.opDiv(b(x), b(y)));
    const r = s(mod.opRem(b(x), b(y)));
    if (q !== wq.toString() || r !== wr.toString()) {
      throw new Error(`${x} / ${y}: got q=${q} r=${r}, want q=${wq} r=${wr}`);
    }
  }
});

Deno.test("arith: division by zero traps", () => {
  for (const x of [0n, 1n, -1n, 1n << 200n]) {
    let trapped = false;
    try {
      mod.opDiv(b(x), b(0n));
    } catch {
      trapped = true;
    }
    if (!trapped) throw new Error(`${x} / 0 did not trap`);
  }
});

Deno.test("shifts: match BigInt including negative values", () => {
  // `shr` is arithmetic, so it floors: -5 >> 1 is -3, not -2. That is BigInt's rule and
  // the one place where the sign-magnitude representation has to work against itself.
  const next = makeRng(0x11223344);
  const values: bigint[] = [0n, 1n, 2n, 3n, 5n, 255n, 256n, 0xffffffffn, 0x100000000n];
  for (let bits = 1; bits <= 200; bits += 11) values.push(randomBits(next, bits));

  for (const mag of values) {
    for (const v of [mag, -mag]) {
      for (const k of [0, 1, 2, 7, 8, 31, 32, 33, 63, 64, 65, 96, 127, 128, 200, 400]) {
        const gotL = s(mod.opShl(b(v), k));
        const wantL = (v << BigInt(k)).toString();
        if (gotL !== wantL) throw new Error(`${v} << ${k}: got ${gotL}, want ${wantL}`);

        const gotR = s(mod.opShr(b(v), k));
        const wantR = (v >> BigInt(k)).toString();
        if (gotR !== wantR) throw new Error(`${v} >> ${k}: got ${gotR}, want ${wantR}`);
      }
    }
  }
});

Deno.test("shifts: a negative count reverses direction", () => {
  const next = makeRng(0x44332211);
  for (let t = 0; t < 60; t++) {
    const mag = randomBits(next, 1 + (next() % 200));
    const v = (next() & 1) === 1 ? -mag : mag;
    for (const k of [1, 5, 32, 33, 70]) {
      const a = s(mod.opShl(b(v), -k));
      const wantA = (v >> BigInt(k)).toString();
      if (a !== wantA) throw new Error(`${v} shl ${-k}: got ${a}, want ${wantA}`);
      const c = s(mod.opShr(b(v), -k));
      const wantC = (v << BigInt(k)).toString();
      if (c !== wantC) throw new Error(`${v} shr ${-k}: got ${c}, want ${wantC}`);
    }
  }
});

Deno.test("shifts: shifting everything out", () => {
  // Past the whole width: zero for a positive value, -1 for a negative one, because
  // flooring never reaches zero from below.
  for (const mag of [1n, 255n, 1n << 100n]) {
    for (const k of [200, 500]) {
      if (s(mod.opShr(b(mag), k)) !== "0") throw new Error(`${mag} >> ${k} was not 0`);
      if (s(mod.opShr(b(-mag), k)) !== "-1") throw new Error(`${-mag} >> ${k} was not -1`);
    }
  }
});

Deno.test("mulSmall and divSmall match the general operations", () => {
  // The single-limb paths are separate code, so they are compared against both BigInt
  // and the general versions.
  const next = makeRng(0x2b2b2b2b);
  const smalls = [1, 2, 3, 10, 255, 65535, 65536, 1000000000, 0x7fffffff, -1, -2];
  for (let t = 0; t < 120; t++) {
    const mag = randomBits(next, 1 + (next() % 250));
    const v = (next() & 1) === 1 ? -mag : mag;
    for (const m of smalls) {
      // The probe takes an i32 and reinterprets it as u32, so a negative m here means
      // a large unsigned multiplier — that is the point, it reaches the top of the range.
      const mu = BigInt(m >>> 0);
      const gotM = s(mod.opMulSmall(b(v), m));
      const wantM = (v * mu).toString();
      if (gotM !== wantM) throw new Error(`${v} *small ${mu}: got ${gotM}, want ${wantM}`);

      if (mu === 0n) continue;
      const gotQ = s(mod.opDivSmall(b(v), m));
      const wantQ = (v / mu).toString();
      if (gotQ !== wantQ) throw new Error(`${v} /small ${mu}: got ${gotQ}, want ${wantQ}`);

      // divSmall's remainder is an unsigned magnitude, unlike divmod's.
      const gotR = BigInt(mod.opRemSmall(b(v), m) >>> 0);
      const absV = v < 0n ? -v : v;
      const wantR = absV % mu;
      if (gotR !== wantR) throw new Error(`${v} %small ${mu}: got ${gotR}, want ${wantR}`);
    }
  }
});

Deno.test("cmp and cmpAbs match BigInt", () => {
  const next = makeRng(0x6a6a6a6a);
  const values: bigint[] = [0n, 1n, 2n, 0xffffffffn, 0x100000000n];
  for (let bits = 1; bits <= 200; bits += 17) values.push(randomBits(next, bits));
  const signed: bigint[] = [];
  for (const v of values) signed.push(v, -v);

  const sign = (x: bigint): number => x < 0n ? -1 : x > 0n ? 1 : 0;
  for (const x of signed) {
    for (const y of signed) {
      const got = mod.opCmp(b(x), b(y));
      const want = sign(x - y);
      if (got !== want) throw new Error(`cmp ${x} ${y}: got ${got}, want ${want}`);

      const ax = x < 0n ? -x : x;
      const ay = y < 0n ? -y : y;
      const gotA = mod.opCmpAbs(b(x), b(y));
      const wantA = sign(ax - ay);
      if (gotA !== wantA) throw new Error(`cmpAbs ${x} ${y}: got ${gotA}, want ${wantA}`);
    }
  }
});

Deno.test("negate, abs and copy preserve value", () => {
  const next = makeRng(0x9e9e9e9e);
  const values: bigint[] = [0n, 1n, 0xffffffffn, 0x100000000n];
  for (let bits = 1; bits <= 200; bits += 13) values.push(randomBits(next, bits));
  for (const mag of values) {
    for (const v of [mag, -mag]) {
      const n = s(mod.opNeg(b(v)));
      if (n !== (-v).toString()) throw new Error(`neg ${v}: got ${n}`);
      const a = s(mod.opAbs(b(v)));
      if (a !== (v < 0n ? -v : v).toString()) throw new Error(`abs ${v}: got ${a}`);
      const c = s(mod.opCopy(b(v)));
      if (c !== v.toString()) throw new Error(`copy ${v}: got ${c}`);
    }
  }
});

Deno.test("negating zero cannot produce -0", () => {
  // Canonical form says `neg` is false whenever the value is zero, and the whole
  // comparison story depends on it.
  for (const z of ["0", "-0"]) {
    const got = s(mod.opNeg(enc.encode(z)));
    if (got !== "0") throw new Error(`neg ${z}: got ${got}`);
  }
  // And a subtraction that lands exactly on zero, which is the way it happens in practice.
  const big = (1n << 200n) + 12345n;
  const got = s(mod.opSub(b(big), b(big)));
  if (got !== "0") throw new Error(`x - x: got ${got}`);
});
