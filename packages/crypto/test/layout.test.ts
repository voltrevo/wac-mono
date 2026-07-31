// layout.wac against DataView.
//
// These conversions are used by every primitive in the package, so they are already
// checked a thousand times over by the NIST and RFC vectors — but only in composition,
// and only at the offsets and widths those algorithms happen to use. A direct test is
// worth having because the failure mode is narrow and quiet: a byte order that is right
// for the aligned, whole-word cases the vectors exercise and wrong for an offset or a
// value the package does not currently produce. `DataView` is an independent
// implementation of exactly this, with an explicit endianness flag, which makes it a
// real oracle rather than a restatement.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind(new URL("./wac/probe.wac", import.meta.url).pathname);
const leWord32 = mod.leWord32 as (b: Uint8Array, i: number) => number;
const beWord32 = mod.beWord32 as (b: Uint8Array, i: number) => number;
const beWord64 = mod.beWord64 as (b: Uint8Array, i: number) => bigint;
const storeLE32 = mod.storeLE32 as (v: number) => Uint8Array;
const storeBE32 = mod.storeBE32 as (v: number) => Uint8Array;
const storeBE64 = mod.storeBE64 as (v: bigint) => Uint8Array;
const padTo16 = mod.padTo16 as (n: number) => number;

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");

/**
 * Reinterpret a value that crossed the wasm boundary as the unsigned quantity it is.
 *
 * `u32` and `u64` are `i32` and `i64` in wasm, and the JS API converts both to signed —
 * so a `u32` return with its top bit set arrives 2^32 too small, and a `u64` 2^64 too
 * small. Bindgen could narrow this and currently does not (wac issue 0039), so callers
 * have to. Doing it through named helpers rather than a stray `>>> 0` is deliberate:
 * the habitual `>>> 0` in the 32-bit half of this file is what hid the same problem in
 * the 64-bit half until it was written without one.
 */
const u32 = (x: number) => x >>> 0;
const u64 = (x: bigint) => BigInt.asUintN(64, x);

/**
 * Values chosen so that a swapped byte order, a sign-extended high byte, or an
 * off-by-one offset each produce a different answer: asymmetric bytes, a high bit set,
 * and the two extremes.
 */
const U32_VALUES = [
  0x00000000, 0x00000001, 0x000000FF, 0x0000FF00, 0x00FF0000, 0xFF000000,
  0x01020304, 0x80000000, 0x7FFFFFFF, 0xFFFFFFFF, 0xDEADBEEF, 0xCAFEBABE,
];

const U64_VALUES = [
  0n, 1n, 0xFFn, 0xFF00000000000000n, 0x0102030405060708n,
  0x8000000000000000n, 0x7FFFFFFFFFFFFFFFn, 0xFFFFFFFFFFFFFFFFn,
  0xDEADBEEFCAFEBABEn,
];

Deno.test("layout: 32-bit reads match DataView in both orders, at every offset", () => {
  // A buffer long enough to read a word at any of several offsets, including unaligned
  // ones — the algorithms only ever read at multiples of four, so the odd offsets are
  // exactly the untested case.
  const buf = Uint8Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 0xFF);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let off = 0; off + 4 <= buf.length; off++) {
    const le = u32(leWord32(buf, off));
    const be = u32(beWord32(buf, off));
    const wantLE = dv.getUint32(off, true);
    const wantBE = dv.getUint32(off, false);
    if (le !== wantLE) throw new Error(`leWord32 at ${off}: got ${le.toString(16)}, want ${wantLE.toString(16)}`);
    if (be !== wantBE) throw new Error(`beWord32 at ${off}: got ${be.toString(16)}, want ${wantBE.toString(16)}`);
  }
});

Deno.test("layout: 64-bit reads match DataView at every offset", () => {
  const buf = Uint8Array.from({ length: 20 }, (_, i) => (i * 53 + 7) & 0xFF);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let off = 0; off + 8 <= buf.length; off++) {
    const got = u64(beWord64(buf, off));
    const want = dv.getBigUint64(off, false);
    if (got !== want) {
      throw new Error(`beWord64 at ${off}: got ${got.toString(16)}, want ${want.toString(16)}`);
    }
  }
  // A byte with the high bit set must not sign-extend into the word. This is the slip
  // the vectors would catch only in a digest that happens to differ, so pin it here.
  const high = new Uint8Array(8);
  high[0] = 0x80;
  if (u64(beWord64(high, 0)) !== 0x8000000000000000n) {
    throw new Error(`a 0x80 leading byte sign-extended: ${u64(beWord64(high, 0)).toString(16)}`);
  }
});

Deno.test("layout: stores match DataView, and round-trip with the reads", () => {
  for (const v of U32_VALUES) {
    const le = storeLE32(v);
    const be = storeBE32(v);
    const ref = new DataView(new ArrayBuffer(4));

    ref.setUint32(0, v, true);
    const wantLE = hex(new Uint8Array(ref.buffer.slice(0)));
    ref.setUint32(0, v, false);
    const wantBE = hex(new Uint8Array(ref.buffer.slice(0)));

    if (hex(le) !== wantLE) throw new Error(`storeLE32(${v.toString(16)}): ${hex(le)} != ${wantLE}`);
    if (hex(be) !== wantBE) throw new Error(`storeBE32(${v.toString(16)}): ${hex(be)} != ${wantBE}`);

    // Reading back what was written is the property the algorithms actually rely on.
    if (u32(leWord32(le, 0)) !== u32(v)) throw new Error(`LE32 round trip failed for ${v.toString(16)}`);
    if (u32(beWord32(be, 0)) !== u32(v)) throw new Error(`BE32 round trip failed for ${v.toString(16)}`);
    // And the two orders agree only on a palindrome, which none of these are except 0
    // and 0xFFFFFFFF — a useful check that the two are not the same function.
    const palindromic = v === 0 || v === 0xFFFFFFFF;
    if ((hex(le) === hex(be)) !== palindromic) {
      throw new Error(`LE and BE agreed on ${v.toString(16)}, which is not byte-symmetric`);
    }
  }

  for (const v of U64_VALUES) {
    const be = storeBE64(v);
    const ref = new DataView(new ArrayBuffer(8));
    ref.setBigUint64(0, v, false);
    const want = hex(new Uint8Array(ref.buffer.slice(0)));
    if (hex(be) !== want) throw new Error(`storeBE64(${v.toString(16)}): ${hex(be)} != ${want}`);
    if (u64(beWord64(be, 0)) !== v) throw new Error(`BE64 round trip failed for ${v.toString(16)}`);
  }
});

Deno.test("layout: padTo16 is the distance to the next block boundary, never a whole block", () => {
  for (let n = 0; n <= 64; n++) {
    const got = padTo16(n);
    // Stated as the property rather than recomputed the same way: the sum must land on
    // a boundary, the padding must be less than a block, and it must be zero exactly
    // when the input is already aligned.
    if ((n + got) % 16 !== 0) throw new Error(`padTo16(${n}) = ${got} does not reach a boundary`);
    if (got < 0 || got > 15) throw new Error(`padTo16(${n}) = ${got} is not in 0..15`);
    if ((got === 0) !== (n % 16 === 0)) throw new Error(`padTo16(${n}) = ${got} but n % 16 = ${n % 16}`);
  }
});
