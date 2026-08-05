// f32 formatting and parsing.
//
// JavaScript has no f32, so `String(x)` is not the oracle it was for doubles.
// Instead the two defining properties are checked directly: the output must read
// back as the same f32, and no shorter decimal may do so. That is what "shortest
// round-tripping" means, and checking it this way is stronger than comparing
// against another implementation's opinion.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/fmt/test/f32_probe.wac") as unknown as {
  fmt32(x: number): Uint8Array;
  fmt32Str(x: number): Uint8Array;
  parse32(b: Uint8Array): number;
};
const dec = new TextDecoder();
const enc = new TextEncoder();
const fmt = (x: number): string => dec.decode(mod.fmt32(x));
/** The same number through `ftoa32`, the string spelling `README.md` documents. */
const fmtStr = (x: number): string => dec.decode(mod.fmt32Str(x));
const parse = (s: string): number => mod.parse32(enc.encode(s));

/** The f32 nearest x, as a JS number. */
const f32 = (x: number): number => Math.fround(x);

Deno.test("f32: specials and zeros", () => {
  const cases: [number, string][] = [
    [NaN, "NaN"], [Infinity, "Infinity"], [-Infinity, "-Infinity"],
    [0, "0"], [-0, "0"],
  ];
  for (const [x, want] of cases) {
    if (fmt(x) !== want) throw new Error(`${want}: got ${fmt(x)}`);
  }
});

Deno.test("f32: output round-trips and is shortest", () => {
  // Two properties, checked separately. Round-tripping alone would be satisfied by
  // printing the exact value, which is never what is wanted.
  const view = new DataView(new ArrayBuffer(4));
  let seed = 0x1f123bb5;
  const next = (): number => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;  seed >>>= 0;
    return seed;
  };

  let checked = 0;
  for (let i = 0; i < 6000; i++) {
    view.setUint32(0, next());
    const x = view.getFloat32(0);
    if (!Number.isFinite(x)) continue;
    checked++;

    const s = fmt(x);
    if (!Object.is(f32(Number(s)), x)) {
      throw new Error(`${s} does not read back as the f32 ${x}`);
    }
    // Shortest: no representation with fewer *significant* digits round-trips.
    // Trailing zeros are exponent, not information — 8324640000000 carries six
    // significant digits, and counting thirteen made this check reject a correct
    // answer.
    const digits = significantDigits(s);
    for (let p = 1; p < digits; p++) {
      if (Object.is(f32(Number(x.toPrecision(p))), x)) {
        throw new Error(`${s} is not shortest: ${x.toPrecision(p)} also round-trips`);
      }
    }
  }
  console.log(`  ${checked} f32 values formatted, round-tripped and minimal`);
});

/** Significant digits in a decimal string: no sign, point, exponent or padding. */
function significantDigits(s: string): number {
  const mantissa = s.replace(/e.*$/i, "").replace(/[-.]/g, "");
  const trimmed = mantissa.replace(/^0+/, "").replace(/0+$/, "");
  return trimmed.length === 0 ? 1 : trimmed.length;
}

Deno.test("f32: the string spelling and the bytes spelling agree", () => {
  // `ftoa32` and `ftoa32Bytes` differ only in `Buf.toStr()` against `Buf.bytes()`, and until now nothing
  // had ever called the first — `deno task dead` found it, and `packages/fmt/README.md` lists it as the
  // package's f32 API. Both now go through `writeF32`, so this is what would notice if one of them stopped.
  const view = new DataView(new ArrayBuffer(4));
  let seed = 0x2545f491;
  const next = (): number => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;  seed >>>= 0;
    return seed;
  };
  let checked = 0;
  for (const x of [0, -0, NaN, Infinity, -Infinity, f32(0.1), f32(1e-45), f32(3.4028235e38)]) {
    if (fmt(x) !== fmtStr(x)) throw new Error(`${x}: bytes ${fmt(x)} vs string ${fmtStr(x)}`);
    checked++;
  }
  for (let i = 0; i < 2000; i++) {
    view.setUint32(0, next());
    const x = view.getFloat32(0);
    if (Number.isNaN(x)) continue;
    if (fmt(x) !== fmtStr(x)) throw new Error(`${x}: bytes ${fmt(x)} vs string ${fmtStr(x)}`);
    checked++;
  }
  console.log(`  ${checked} f32 values agree through both spellings`);
});

Deno.test("f32: the boundary values", () => {
  const view = new DataView(new ArrayBuffer(4));
  const ofBits = (b: number): number => { view.setUint32(0, b); return view.getFloat32(0); };
  const cases: [number, string][] = [
    [ofBits(1), "1e-45"],                        // smallest subnormal
    [ofBits(0x00800000), "1.1754944e-38"],       // smallest normal
    [ofBits(0x7F7FFFFF), "3.4028235e+38"],       // largest finite
    [f32(1), "1"], [f32(0.1), "0.1"], [f32(0.5), "0.5"],
  ];
  for (const [x, want] of cases) {
    if (fmt(x) !== want) throw new Error(`expected ${want}, got ${fmt(x)}`);
  }
});

Deno.test("f32: parsing is correctly rounded, not doubly rounded", () => {
  // Parsing to f64 and narrowing rounds twice and disagrees near f32 boundaries,
  // so the result is compared against Math.fround of the *exact* decimal — which
  // JS computes in one step from the string.
  const cases = [
    "0", "-0", "1", "-1", "0.1", "0.2", "3.14159265358979",
    "1e-45", "7e-46", "1.1754944e-38", "3.4028235e38", "3.4028236e38",
    "1e39", "-1e39", "1e-50", "16777216", "16777217", "16777218",
    "1.00000005960464477539062", "0.999999940395355224609375",
    "123456789012345678901234567890", "2.5e-324",
  ];
  for (const s of cases) {
    const got = parse(s), want = f32(Number(s));
    if (!Object.is(got, want)) throw new Error(`${s}: got ${got}, want ${want}`);
  }
});

Deno.test("f32: parse and format are inverse over random values", () => {
  const view = new DataView(new ArrayBuffer(4));
  let seed = 0x9e3779b1;
  const next = (): number => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;  seed >>>= 0;
    return seed;
  };
  let checked = 0;
  for (let i = 0; i < 4000; i++) {
    view.setUint32(0, next());
    const x = view.getFloat32(0);
    if (!Number.isFinite(x)) continue;
    checked++;
    if (!Object.is(parse(fmt(x)), x)) {
      throw new Error(`round trip failed for ${x}: formatted ${fmt(x)}, parsed ${parse(fmt(x))}`);
    }
  }
  console.log(`  ${checked} f32 values survived format-then-parse`);
});
