// Decimal -> f64 against the host's own conversion, compared bit-exactly.
//
// This is the part of the parser most likely to be subtly wrong: wac has no
// wide-integer type, so scaling is done in f64 (see parse.wac). Anything that
// needs more than an i64 mantissa or a power of ten outside ±1e22 can only be
// correct to within a rounding step.

import { assertSameNumber, numberValue } from "./util.ts";

/** Values where the fast path is provably exact: mantissa < 2^53, |exp| <= 22. */
const EXACT = [
  "0", "-0", "1", "-1", "42", "-42",
  "1.5", "-1.5", "0.5", "2.25", "3.14159",
  "100", "1000000", "123456789",
  "9007199254740991",          // 2^53 - 1
  "1e0", "1e1", "1e10", "1e22", "1E2",
  "1e-1", "1e-10", "1e-22",
  "-1e10", "-1e-10",
  "1.5e3", "1.5e-3", "1.5E+3",
  "0.1", "0.2", "0.3",
  "2.5e10", "7.25e-5",
  "0e0", "0e100", "0e-100",
  "-0.0", "0.0",
];

/** Values that exercise the parts that cannot be exact by construction. */
const HARD = [
  "1e23",                      // first power of ten past the exact table
  "1e100", "1e308", "-1e308",
  "1e-100", "1e-308",
  "1e309",                     // overflows to Infinity
  "-1e309",
  "1e-400",                    // underflows to 0
  "123456789012345678901234567890",
  "0.1234567890123456789012345",
  "1.7976931348623157e308",    // f64 max
  "5e-324",                    // smallest subnormal
  "2.2250738585072014e-308",   // smallest normal
  "1234567890.1234567890",
  "9007199254740993",          // 2^53 + 1, not representable
  "1.000000000000000000001",
];

Deno.test("exact cases match the host bit-for-bit", async () => {
  for (const src of EXACT) {
    assertSameNumber(await numberValue(src), Number(src), `for ${src}`);
  }
});

Deno.test("hard cases: report agreement, bound the error", async () => {
  const off: string[] = [];
  for (const src of HARD) {
    const got = await numberValue(src);
    const want = Number(src);
    if (Object.is(got, want)) continue;
    // Distance in representable steps, which is the only honest error measure
    // for a float conversion.
    const ulps = ulpsApart(got, want);
    off.push(`${src}: got ${got}, want ${want} (${ulps} ulp)`);
    if (!Number.isFinite(ulps) || ulps > 1) {
      throw new Error(`number conversion off by more than one ulp:\n  ${off.join("\n  ")}`);
    }
  }
  if (off.length > 0) {
    console.log(`  ${off.length}/${HARD.length} inexact (all within one ulp):`);
    for (const line of off) console.log(`    ${line}`);
  }
});

// The hand-picked corpus above is chosen to be interesting, which is exactly
// why it cannot establish the error rate. This does: random decimals across the
// whole exponent range, compared against the host, reporting the distribution
// rather than asserting a hope.
Deno.test("random decimals: measure the error distribution", async () => {
  const ROUNDS = 3000;
  let seed = 0x9e3779b9;
  const rnd = () => {
    // xorshift32 — deterministic, so a failure is reproducible.
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;  seed >>>= 0;
    return seed / 0x100000000;
  };

  const hist = new Map<number, number>();
  let worst = { src: "", ulps: 0 };

  for (let i = 0; i < ROUNDS; i++) {
    const digits = 1 + Math.floor(rnd() * 19);
    let mant = "";
    for (let d = 0; d < digits; d++) {
      mant += Math.floor(rnd() * 10).toString();
    }
    mant = mant.replace(/^0+(?=\d)/, "");
    const exp = Math.floor(rnd() * 640) - 320;
    const sign = rnd() < 0.5 ? "-" : "";
    const src = `${sign}${mant}e${exp}`;

    const got = await numberValue(src);
    const want = Number(src);
    const ulps = Object.is(got, want) ? 0 : ulpsApart(got, want);
    hist.set(ulps, (hist.get(ulps) ?? 0) + 1);
    if (ulps > worst.ulps) worst = { src, ulps };
  }

  const keys = [...hist.keys()].sort((a, b) => a - b);
  const summary = keys.map(k => `${k} ulp: ${hist.get(k)}`).join(", ");
  const exact = hist.get(0) ?? 0;
  console.log(`  ${ROUNDS} random decimals — ${summary}`);
  console.log(`  exact: ${((exact / ROUNDS) * 100).toFixed(1)}%; worst: ${worst.src} at ${worst.ulps} ulp`);

  if (!Number.isFinite(worst.ulps) || worst.ulps > 2) {
    throw new Error(`conversion error exceeded 2 ulp: ${worst.src} off by ${worst.ulps}`);
  }
});

/** Steps between two f64s, via their monotonic integer ordering. */
function ulpsApart(a: number, b: number): number {
  if (Object.is(a, b)) return 0;
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  const buf = new DataView(new ArrayBuffer(8));
  const ord = (x: number): bigint => {
    buf.setFloat64(0, x);
    const bits = buf.getBigUint64(0);
    // Flip so that the ordering is monotonic across the sign boundary.
    return bits & (1n << 63n) ? -(bits & ~(1n << 63n)) : bits;
  };
  const d = ord(a) - ord(b);
  return Number(d < 0n ? -d : d);
}
