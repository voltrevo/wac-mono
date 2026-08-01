// Branch coverage for codec.
//
// The same exercises the tests run: the RFC vectors, a round trip at every length up to 300 —
// which is what reaches each short-group case — and the strictness inputs, which are the only
// things that reach the rejection paths at all.
//
//   deno task coverage:codec
//   deno task coverage:codec --verbose

import { instrument, report } from "../../harness/wacCoverage.ts";

const verbose = Deno.args.includes("--verbose");
const enc = new TextEncoder();

const run = await instrument("packages/codec/test/probe.wac");
const m = run.mod as unknown as {
  hexEnc(d: Uint8Array): Uint8Array;
  hexEncUpper(d: Uint8Array): Uint8Array;
  hexDec(t: Uint8Array): Uint8Array;
  hexAccepts(t: Uint8Array): boolean;
  b64Enc(d: Uint8Array, url: boolean, pad: boolean): Uint8Array;
  b64Dec(t: Uint8Array): Uint8Array;
  b64Accepts(t: Uint8Array): boolean;
  b32Enc(d: Uint8Array, hex: boolean, pad: boolean): Uint8Array;
  b32Dec(t: Uint8Array, hex: boolean): Uint8Array;
  b32Accepts(t: Uint8Array, hex: boolean): boolean;
};

let x = 0x77aa11bb | 0;
const next = (): number => {
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5; x >>>= 0;
  return x;
};

/** Every length up to 300, which is what walks through all four short-group shapes repeatedly. */
for (let len = 0; len <= 300; len++) {
  const data = new Uint8Array(len);
  for (let i = 0; i < len; i++) data[i] = next() & 255;
  for (const pad of [true, false]) {
    m.hexDec(m.hexEnc(data));
    m.hexDec(m.hexEncUpper(data));
    for (const url of [true, false]) m.b64Dec(m.b64Enc(data, url, pad));
    for (const hex of [true, false]) m.b32Dec(m.b32Enc(data, hex, pad), hex);
  }
}

/** The rejection paths, which nothing well-formed reaches. */
for (
  const t of [
    "A", "AAAAA", "A===", "AB=A", "=", "AB=", "ABCDE=", "A@AA", "AA A", "QR==", "Zm9vYmF=",
    "", "AA", "QQ", "Zm9v", "Zm9vYg", "Zm9vYmE", "====", "=A", "AAAA=", "AA@", "A@A", "@AA",
  ]
) {
  m.b64Accepts(enc.encode(t));
  m.b64Dec(enc.encode(t));
}

for (
  const t of [
    "A", "AAA", "AAAAAA", "AAAAAAAAA", "A=======", "AAA=====", "", "AA", "AAAA", "AAAAA",
    "AAAAAAA", "AAAAAAAA", "MY======", "MY=====", "MY=======", "MZXW6===", "MZXW6==",
    "MZ======", "M2======", "8=======", "@@@@@@@@", "=======",
    // Lowercase, which decoders must accept.
    "my======", "mzxw6yTBOI======", "cpnmuoj1", "cpnmuoj1e8======",
  ]
) {
  for (const hex of [true, false]) {
    m.b32Accepts(enc.encode(t), hex);
    m.b32Dec(enc.encode(t), hex);
  }
}

for (const t of ["0", "abc", "0g", "0 0", "0x00", "", "00", "ff", "FF", "aA", "0123456789abcdefABCDEF"]) {
  m.hexAccepts(enc.encode(t));
  m.hexDec(enc.encode(t));
}

report([run], "packages/codec/", { verbose });
