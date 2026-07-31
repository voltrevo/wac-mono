// f64 -> string, judged against the host's own Number::toString.
//
// The point of matching JavaScript exactly is that `String(x)` becomes an oracle
// for every finite double, so correctness is not a matter of inspecting output.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/fmt/src/ftoa.wac") as unknown as {
  ftoaBytes(x: number): Uint8Array;
};
const dec = new TextDecoder();
const ftoa = (x: number): string => dec.decode(mod.ftoaBytes(x));

function check(x: number, label = ""): string | null {
  const got = ftoa(x);
  const want = String(x);
  return got === want ? null : `${label}${label ? " " : ""}${want}: got ${JSON.stringify(got)}`;
}

Deno.test("ftoa: specials and zeros", () => {
  const cases: [number, string][] = [
    [NaN, "NaN"],
    [Infinity, "Infinity"],
    [-Infinity, "-Infinity"],
    [0, "0"],
    [-0, "0"],
  ];
  for (const [x, want] of cases) {
    const got = ftoa(x);
    if (got !== want) throw new Error(`${want}: got ${JSON.stringify(got)}`);
  }
});

Deno.test("ftoa: hand-picked hard cases match String(x)", () => {
  const cases = [
    1, -1, 2, 10, 100, 1000, 123456789,
    0.1, 0.2, 0.3, 0.5, 1.5, -2.25, 1 / 3, 2 / 3,
    // Shortest-representation classics: the naive answer has too many digits.
    5e-324, 2.2250738585072014e-308, 1.7976931348623157e308,
    9007199254740991, 9007199254740992, 9007199254740993,
    // Powers of two, where the gap below is half the gap above.
    4, 1024, 2 ** 52, 2 ** 53, 2 ** -1022, 2 ** 1023,
    // The notation boundaries in ECMA-262.
    1e20, 1e21, 1e-6, 1e-7, 1.2e21, 1.2e-7,
    // Values whose shortest form famously differs from a naive conversion.
    5e-1, 1e23, 8.98846567431158e307, 2.225073858507201e-308,
    123456789012345678000, 0.000001, 0.0000001,
    1e-323, 4.9e-324, 3e-324,
    // Round-half cases.
    1.005, 2.675, 8.5, 0.35,
  ];
  const bad: string[] = [];
  for (const x of cases) {
    const m = check(x);
    if (m) bad.push(m);
  }
  if (bad.length) throw new Error(`${bad.length}/${cases.length} mismatched:\n  ${bad.join("\n  ")}`);
});

Deno.test("ftoa: random bit patterns match String(x)", () => {
  // Uniform over bit patterns, so subnormals, huge exponents and long
  // significands all appear — the distribution a decimal-based corpus misses.
  const view = new DataView(new ArrayBuffer(8));
  let seed = 0x2545f491;
  const next = (): number => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;  seed >>>= 0;
    return seed;
  };

  const ROUNDS = 20000;
  const bad: string[] = [];
  let checked = 0;
  for (let i = 0; i < ROUNDS; i++) {
    view.setUint32(0, next());
    view.setUint32(4, next());
    const x = view.getFloat64(0);
    if (!Number.isFinite(x)) continue;
    checked++;
    const m = check(x, `bits`);
    if (m) { bad.push(m); if (bad.length > 20) break; }
  }
  if (bad.length) {
    throw new Error(`${bad.length} of ${checked} random doubles mismatched:\n  ${bad.join("\n  ")}`);
  }
  if (checked < ROUNDS / 2) throw new Error(`only ${checked} finite doubles out of ${ROUNDS}`);
});

Deno.test("ftoa: random decimals and integers match String(x)", () => {
  // Values people actually write, which cluster in the plain-notation range where
  // the trailing-zero and decimal-point rules apply.
  let seed = 0x9e3779b9;
  const next = (): number => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;  seed >>>= 0;
    return seed / 0x100000000;
  };
  const bad: string[] = [];
  for (let i = 0; i < 8000; i++) {
    const digits = 1 + Math.floor(next() * 17);
    let mant = "";
    for (let d = 0; d < digits; d++) mant += Math.floor(next() * 10).toString();
    const exp = Math.floor(next() * 60) - 30;
    const x = Number(`${next() < 0.5 ? "-" : ""}${mant}e${exp}`);
    if (!Number.isFinite(x)) continue;
    const m = check(x);
    if (m) { bad.push(m); if (bad.length > 20) break; }
  }
  if (bad.length) throw new Error(`${bad.length} decimals mismatched:\n  ${bad.join("\n  ")}`);
});

Deno.test("ftoa: every output round-trips back to the same double", () => {
  // Independent of the String(x) comparison: shortest is only meaningful if the
  // digits actually read back as the original value.
  const view = new DataView(new ArrayBuffer(8));
  let seed = 0x1234567;
  const next = (): number => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;  seed >>>= 0;
    return seed;
  };
  let checked = 0;
  for (let i = 0; i < 5000; i++) {
    view.setUint32(0, next());
    view.setUint32(4, next());
    const x = view.getFloat64(0);
    if (!Number.isFinite(x)) continue;
    checked++;
    const s = ftoa(x);
    if (!Object.is(Number(s), x)) {
      throw new Error(`${s} does not read back as ${x}`);
    }
  }
  console.log(`  ${checked} doubles round-tripped`);
});
