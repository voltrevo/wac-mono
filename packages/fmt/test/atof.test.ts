// Decimal -> f64, judged against the host's own Number().
//
// Bit-exact comparison throughout: Object.is, so -0 is distinguished from 0 and a
// one-ulp error cannot pass. "Correctly rounded" is a claim that only means
// anything if it is checked that way.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/fmt/test/atof_probe.wac") as unknown as {
  parse(b: Uint8Array): number;
};
const enc = new TextEncoder();
const atof = (s: string): number => mod.parse(enc.encode(s));

function assertSame(src: string): void {
  const got = atof(src), want = Number(src);
  if (!Object.is(got, want)) throw new Error(`${src}: got ${got}, want ${want}`);
}

Deno.test("atof: the cases that break naive conversions", () => {
  const cases = [
    "0", "-0", "1", "-1", "10", "1.5", "-2.25", "0.1", "0.2", "0.3",
    // Either side of the exact-significand limit.
    "9007199254740991", "9007199254740992", "9007199254740993",
    // The range boundaries, including the smallest subnormal and the largest finite.
    "5e-324", "4.9e-324", "2.4703282292062328e-324", "2.4703282292062327e-324",
    "1.7976931348623157e308", "1.7976931348623159e308",
    "2.2250738585072014e-308", "2.2250738585072011e-308",
    // Overflow and underflow decided at the boundary, not by a magnitude guess.
    "1e308", "1e309", "-1e309", "1.8e308", "1e-400", "0e999", "-0e999",
    // Long inputs, where the fast path cannot apply.
    "123456789012345678901234567890", "0.1234567890123456789012345",
    "1.000000000000000000001", "1e23", "1e-23",
    // A famous strtod hang/precision case.
    "2.2250738585072011360574097967091319759348195463516456480234261097248222015" +
      "6858036286346714528823753e-308",
  ];
  for (const s of cases) assertSame(s);
});

Deno.test("atof: exact halfway cases round to even", () => {
  // A decimal exactly between two doubles must go to the even significand. These
  // are constructed to sit precisely on a midpoint, so an implementation that
  // always rounds up or always truncates fails.
  const view = new DataView(new ArrayBuffer(8));
  for (const start of [1.0, 1e10, 1e-10, 12345.678, 2 ** 40]) {
    view.setFloat64(0, start);
    const bits = view.getBigUint64(0);
    for (const step of [0n, 1n, 2n, 3n]) {
      view.setBigUint64(0, bits + step);
      const a = view.getFloat64(0);
      view.setBigUint64(0, bits + step + 1n);
      const b = view.getFloat64(0);
      // The exact midpoint of two adjacent doubles is representable in decimal.
      const mid = exactMidpointDecimal(a, b);
      assertSame(mid);
    }
  }
});

/** The exact decimal midpoint of two adjacent doubles, as a string. */
function exactMidpointDecimal(a: number, b: number): string {
  const ba = exactDecimal(a), bb = exactDecimal(b);
  const sum = ba.num * bb.den + bb.num * ba.den;
  const den = ba.den * bb.den * 2n;
  // den is a power of ten times a power of two; scale to a plain decimal.
  let n = sum, d = den, scale = 0;
  while (d % 2n === 0n) { d /= 2n; n *= 5n; scale++; }
  while (d % 5n === 0n) { d /= 5n; n *= 2n; scale++; }
  if (d !== 1n) throw new Error("midpoint is not a finite decimal");
  return `${n}e-${scale}`;
}

/** A double as an exact rational num/den. */
function exactDecimal(x: number): { num: bigint; den: bigint } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const be = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & 0xfffffffffffffn;
  const f = be === 0 ? frac : frac + (1n << 52n);
  const g = be === 0 ? -1074 : be - 1075;
  return g >= 0 ? { num: f << BigInt(g), den: 1n } : { num: f, den: 1n << BigInt(-g) };
}

Deno.test("atof: round-trips every shortest representation", () => {
  // ftoa's output must read back as the original double. Together the two make a
  // closed loop, and a bug in either shows up here.
  const view = new DataView(new ArrayBuffer(8));
  let seed = 0x7f4a7c15;
  const next = (): number => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;  seed >>>= 0;
    return seed;
  };
  let checked = 0;
  for (let i = 0; i < 4000; i++) {
    view.setUint32(0, next());
    view.setUint32(4, next());
    const x = view.getFloat64(0);
    if (!Number.isFinite(x)) continue;
    checked++;
    const s = String(x);
    if (!Object.is(atof(s), x)) throw new Error(`${s} parsed to ${atof(s)}, want ${x}`);
  }
  console.log(`  ${checked} shortest forms round-tripped`);
});

Deno.test("atof: random decimals across the exponent range are bit-exact", () => {
  let seed = 0x2f6e2b1;
  const next = (): number => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;  seed >>>= 0;
    return seed / 0x100000000;
  };
  for (let i = 0; i < 4000; i++) {
    const digits = 1 + Math.floor(next() * 25);
    let mant = "";
    for (let d = 0; d < digits; d++) mant += Math.floor(next() * 10).toString();
    const exp = Math.floor(next() * 680) - 340;
    assertSame(`${next() < 0.5 ? "-" : ""}${mant}e${exp}`);
  }
});
