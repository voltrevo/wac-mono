// Branch coverage for fmt.
//
// Formatting and parsing are driven from the host, and the bignum only through them,
// so one entry point reaches everything. The exercises are chosen to hit the paths
// the committed tests hit — random bit patterns across the whole f64 range, decimals
// spanning the exponent range, and the boundary values — because coverage against a
// different workload measures that workload.
//
//   deno task coverage:fmt
//   deno task coverage:fmt --verbose

import { instrument, report } from "../../harness/wacCoverage.ts";

const verbose = Deno.args.includes("--verbose");
const enc = new TextEncoder();

const run = await instrument("packages/fmt/test/probe.wac");
const fmtF64 = run.mod.fmtF64 as (x: number) => Uint8Array;
const fmtF32 = run.mod.fmtF32 as (x: number) => Uint8Array;
const parseF64 = run.mod.parseF64 as (b: Uint8Array) => number;
const parseF32 = run.mod.parseF32 as (b: Uint8Array) => number;
const itoaOf = run.mod.itoaOf as (n: number) => Uint8Array;

/** Random bit patterns, which is the only way to reach subnormals and huge exponents. */
const view = new DataView(new ArrayBuffer(8));
let seed = 0x2545f491;
const next = (): number => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5;  seed >>>= 0;
  return seed;
};
for (let i = 0; i < 60000; i++) {
  view.setUint32(0, next());
  view.setUint32(4, next());
  const x = view.getFloat64(0);
  fmtF64(x);
  if (Number.isFinite(x)) parseF64(enc.encode(String(x)));
  view.setUint32(0, next());
  fmtF32(view.getFloat32(0));
}

/** The values that pick out particular branches rather than a random sample. */
for (
  const x of [
    0, -0, 1, -1, 0.1, 0.5, 1.5, -2.25, 1e20, 1e21, 1e-6, 1e-7, 1e23,
    5e-324, 2.2250738585072014e-308, 1.7976931348623157e308,
    9007199254740991, 9007199254740993, 8324640000000, 887976063517795.2,
    NaN, Infinity, -Infinity,
  ]
) {
  fmtF64(x);
  fmtF32(x);
}

/**
 * Neighbours of round decimals, which is where a rounded-up 9 lives.
 *
 * Random bit patterns never reach the carry path: 60 000 of them leave it untouched,
 * because a value whose shortest form needs a carry sits immediately below a round
 * decimal and that is a vanishing fraction of the space.
 */
const bitsOf = (x: number): bigint => { view.setFloat64(0, x); return view.getBigUint64(0); };
const ofBits = (b: bigint): number => { view.setBigUint64(0, b); return view.getFloat64(0); };
for (let k = -320; k <= 300; k++) {
  for (let d = 1; d <= 99; d++) {
    const target = Number(`${d}e${k}`);
    if (!Number.isFinite(target) || target === 0) continue;
    const base = bitsOf(target);
    for (let step = -2n; step <= 2n; step++) {
      const x = ofBits(base + step);
      if (Number.isFinite(x)) fmtF64(x);
    }
  }
}

/** Parsing: the fast path, Clinger's extension, and the exact fallback. */
for (
  const s of [
    "0", "-0", "1", "1.5", "0.1", "1e5", "1e22", "1e23", "1e30", "1e37", "1e38",
    "1e308", "1e309", "-1e309", "1e-308", "1e-400", "5e-324", "4.9e-324",
    "9007199254740993", "123456789012345678901234567890",
    "0.1234567890123456789012345", "2.2250738585072011e-308",
    "1.00000000000000000000001e300",
    // 800+ significant digits, which is where the sticky flag and the digit cap live.
    "1." + "9".repeat(900) + "e10",
    "0." + "0".repeat(320) + "1234567890",
  ]
) {
  parseF64(enc.encode(s));
  parseF32(enc.encode(s));
}

/** itoa, including the value whose negation overflows. */
for (const n of [0, 1, -1, 9, 10, 99, 100, 2147483647, -2147483648, -12345]) itoaOf(n);

/**
 * The wac-written tests are a second entry point.
 *
 * `ftoa`, `ftoa32` and `writeF32` return a `string` or write into a Buf, so they are
 * called from wac rather than from here — a report over this file alone shows them
 * dead when they are covered.
 */
const testRun = await instrument("packages/fmt/test/wac/ftoa_test.wac");
for (const [name, fn] of Object.entries(testRun.mod)) {
  if (!name.startsWith("test") || typeof fn !== "function") continue;
  const failure = (fn as () => string)();
  if (failure !== "") throw new Error(`${name} failed during coverage: ${failure}`);
}

report([run, testRun], "packages/fmt/", { verbose });
