// Base16, base32 and base64, judged against RFC 4648 and against the platform where it has one.
//
// Three kinds of check, in decreasing order of authority:
//
//   1. The test vectors in RFC 4648 §10. Normative text, so stronger evidence than any
//      implementation: an implementation can be wrong, the vectors define what right is.
//   2. Differential against `btoa`/`atob` and a hex reference, over random input. Only for
//      *encoding* and only for well-formed input, because the platform decoders are lenient in
//      ways this deliberately is not.
//   3. Round-trip over random bytes, which is what catches a length or shift bug at a size the
//      hand-written vectors do not reach.
//
// Point 2 is worth being careful about. `atob` accepts input RFC 4648 rejects — bad padding,
// non-zero unused bits — so "agrees with atob" is the wrong property for a decoder. The
// strictness suite asserts the rejections directly instead.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/codec/test/probe.wac") as unknown as {
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

const enc = new TextEncoder();
const dec = new TextDecoder();
const b = (s: string): Uint8Array => enc.encode(s);
const s = (u: Uint8Array): string => dec.decode(u);
const bytes = (a: Uint8Array): string => Array.from(a).join(",");

/**
 * RFC 4648 §10, verbatim.
 *
 * Every row of the table in the RFC, for every encoding it covers. These are the whole point of
 * choosing an encoding with a normative test vector set.
 */
const RFC_VECTORS: Array<{ input: string; b16: string; b32: string; b32hex: string; b64: string }> = [
  { input: "", b16: "", b32: "", b32hex: "", b64: "" },
  { input: "f", b16: "66", b32: "MY======", b32hex: "CO======", b64: "Zg==" },
  { input: "fo", b16: "666F", b32: "MZXQ====", b32hex: "CPNG====", b64: "Zm8=" },
  { input: "foo", b16: "666F6F", b32: "MZXW6===", b32hex: "CPNMU===", b64: "Zm9v" },
  { input: "foob", b16: "666F6F62", b32: "MZXW6YQ=", b32hex: "CPNMUOG=", b64: "Zm9vYg==" },
  { input: "fooba", b16: "666F6F6261", b32: "MZXW6YTB", b32hex: "CPNMUOJ1", b64: "Zm9vYmE=" },
  { input: "foobar", b16: "666F6F626172", b32: "MZXW6YTBOI======", b32hex: "CPNMUOJ1E8======", b64: "Zm9vYmFy" },
];

Deno.test("RFC 4648 test vectors: encoding", () => {
  const bad: string[] = [];
  for (const v of RFC_VECTORS) {
    const data = b(v.input);
    const checks: Array<[string, string, string]> = [
      ["base16", s(mod.hexEncUpper(data)), v.b16],
      ["base32", s(mod.b32Enc(data, false, true)), v.b32],
      ["base32hex", s(mod.b32Enc(data, true, true)), v.b32hex],
      ["base64", s(mod.b64Enc(data, false, true)), v.b64],
    ];
    for (const [what, got, want] of checks) {
      if (got !== want) bad.push(`${what}(${JSON.stringify(v.input)}): got ${got}, RFC says ${want}`);
    }
  }
  if (bad.length > 0) throw new Error(bad.join("\n  "));
});

Deno.test("RFC 4648 test vectors: decoding", () => {
  const bad: string[] = [];
  for (const v of RFC_VECTORS) {
    const want = bytes(b(v.input));
    const checks: Array<[string, string]> = [
      ["base16", bytes(mod.hexDec(b(v.b16)))],
      ["base16 lowercase", bytes(mod.hexDec(b(v.b16.toLowerCase())))],
      ["base32", bytes(mod.b32Dec(b(v.b32), false))],
      // Lowercase, which RFC 4648 requires a decoder to accept even though it never emits it.
      ["base32 lowercase", bytes(mod.b32Dec(b(v.b32.toLowerCase()), false))],
      ["base32hex", bytes(mod.b32Dec(b(v.b32hex), true))],
      ["base32hex lowercase", bytes(mod.b32Dec(b(v.b32hex.toLowerCase()), true))],
      ["base64", bytes(mod.b64Dec(b(v.b64)))],
    ];
    for (const [what, got] of checks) {
      if (got !== want) bad.push(`${what} of ${JSON.stringify(v.input)}: got [${got}], want [${want}]`);
    }
  }
  if (bad.length > 0) throw new Error(bad.join("\n  "));
});

function makeRng(seed: number): () => number {
  let x = seed | 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x;
  };
}

function randomBytes(next: () => number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = next() & 255;
  return out;
}

Deno.test("base64 encoding matches btoa over random input", () => {
  // The platform's *encoder* is a sound oracle even though its decoder is not: btoa produces the
  // one canonical encoding, which is exactly what this produces.
  const next = makeRng(0x1a2b3c4d);
  for (let len = 0; len <= 200; len++) {
    const data = randomBytes(next, len);
    let binary = "";
    for (const byte of data) binary += String.fromCharCode(byte);
    const want = btoa(binary);
    const got = s(mod.b64Enc(data, false, true));
    if (got !== want) throw new Error(`base64 of ${len} bytes: got ${got}, btoa says ${want}`);

    // base64url is the same string with two substitutions and the padding optional.
    const wantUrl = want.replaceAll("+", "-").replaceAll("/", "_");
    const gotUrl = s(mod.b64Enc(data, true, true));
    if (gotUrl !== wantUrl) throw new Error(`base64url of ${len} bytes: got ${gotUrl}, want ${wantUrl}`);
    const gotNoPad = s(mod.b64Enc(data, true, false));
    if (gotNoPad !== wantUrl.replaceAll("=", "")) {
      throw new Error(`unpadded base64url of ${len} bytes: got ${gotNoPad}`);
    }
  }
});

Deno.test("hex encoding matches a reference over random input", () => {
  const next = makeRng(0x5f6e7d8c);
  for (let len = 0; len <= 200; len++) {
    const data = randomBytes(next, len);
    const want = Array.from(data).map(x => x.toString(16).padStart(2, "0")).join("");
    const got = s(mod.hexEnc(data));
    if (got !== want) throw new Error(`hex of ${len} bytes: got ${got}, want ${want}`);
    if (s(mod.hexEncUpper(data)) !== want.toUpperCase()) {
      throw new Error(`uppercase hex of ${len} bytes disagreed`);
    }
  }
});

Deno.test("every encoding round-trips random bytes at every length", () => {
  const next = makeRng(0x77aa11bb);
  for (let len = 0; len <= 300; len++) {
    const data = randomBytes(next, len);
    const want = bytes(data);
    const trips: Array<[string, Uint8Array]> = [
      ["hex", mod.hexDec(mod.hexEnc(data))],
      ["hex upper", mod.hexDec(mod.hexEncUpper(data))],
      ["base64", mod.b64Dec(mod.b64Enc(data, false, true))],
      ["base64 unpadded", mod.b64Dec(mod.b64Enc(data, false, false))],
      ["base64url", mod.b64Dec(mod.b64Enc(data, true, true))],
      ["base64url unpadded", mod.b64Dec(mod.b64Enc(data, true, false))],
      ["base32", mod.b32Dec(mod.b32Enc(data, false, true), false)],
      ["base32 unpadded", mod.b32Dec(mod.b32Enc(data, false, false), false)],
      ["base32hex", mod.b32Dec(mod.b32Enc(data, true, true), true)],
      ["base32hex unpadded", mod.b32Dec(mod.b32Enc(data, true, false), true)],
    ];
    for (const [what, got] of trips) {
      if (bytes(got) !== want) throw new Error(`${what} did not round-trip at ${len} bytes`);
    }
  }
});

Deno.test("base64 decoding is strict where atob is not", () => {
  // Each of these is accepted by at least one platform decoder and rejected here. The comment on
  // each says what is wrong with it.
  const reject: Array<[string, string]> = [
    ["A", "one digit carries six bits and a byte needs eight"],
    ["AAAAA", "the same, one group along"],
    ["A===", "three pads is never right"],
    ["AB=A", "padding is not the last thing"],
    ["=", "padding with nothing to pad"],
    ["AB=", "the pad count does not match the digit count"],
    ["ABCDE=", "likewise"],
    ["A@AA", "not a digit"],
    ["AA A", "whitespace is not skipped, because skipping it is the caller's decision"],
    ["QR==", "the four unused bits are not zero"],
    ["Zm9vYmF=", "the two unused bits are not zero — Zm9vYmE= is the canonical spelling"],
    ["AA@", "a bad digit in the third position of a short group"],
    ["A@A", "and in the second"],
  ];
  const bad: string[] = [];
  for (const [t, why] of reject) {
    if (mod.b64Accepts(b(t))) bad.push(`accepted ${JSON.stringify(t)}, but ${why}`);
  }
  // Unpadded input at a valid length is accepted, which is the other half of the rule.
  for (const t of ["", "AA", "QQ", "Zm9v", "Zm9vYg", "Zm9vYmE"]) {
    if (!mod.b64Accepts(b(t))) bad.push(`rejected well-formed unpadded ${JSON.stringify(t)}`);
  }
  if (bad.length > 0) throw new Error(bad.join("\n  "));
});

Deno.test("the canonical-encoding rule: unused bits must be zero", () => {
  // The rule every lenient decoder drops, and the one that makes an encoding a function rather
  // than a relation. Without it `QQ==` and `QR==` both decode to "A", and a signature over the
  // text says nothing about the bytes.
  const bad: string[] = [];
  if (!mod.b64Accepts(b("QQ=="))) bad.push("QQ== should decode to 'A'");
  if (s(mod.b64Dec(b("QQ=="))) !== "A") bad.push("QQ== decoded wrong");
  for (const t of ["QR==", "QS==", "QV==", "Zm9vYmG="]) {
    if (mod.b64Accepts(b(t))) bad.push(`${t} has non-zero unused bits and should be rejected`);
  }
  // And the same rule in base32, where a short group leaves up to four spare bits.
  if (!mod.b32Accepts(b("MY======"), false)) bad.push("MY====== should decode to 'f'");
  for (const t of ["MZ======", "M2======", "MZXW6YTC"]) {
    if (mod.b32Accepts(b(t), false) && s(mod.b32Dec(b(t), false)).length > 0) {
      const decoded = mod.b32Dec(b(t), false);
      const reencoded = s(mod.b32Enc(decoded, false, true));
      if (reencoded !== t) bad.push(`${t} decoded but re-encodes as ${reencoded}, so it was not canonical`);
    }
  }
  if (bad.length > 0) throw new Error(bad.join("\n  "));
});

Deno.test("base32 decoding rejects impossible group lengths", () => {
  const bad: string[] = [];
  // 1, 3 and 6 digits cannot end a base32 group: the valid counts are 2, 4, 5, 7 and 8.
  for (const t of ["A", "AAA", "AAAAAA", "AAAAAAAAA", "A=======", "AAA====="]) {
    if (mod.b32Accepts(b(t), false)) bad.push(`accepted ${JSON.stringify(t)}`);
  }
  for (const t of ["", "AA", "AAAA", "AAAAA", "AAAAAAA", "AAAAAAAA"]) {
    if (!mod.b32Accepts(b(t), false)) bad.push(`rejected well-formed unpadded ${JSON.stringify(t)}`);
  }
  // Padding must match the digit count exactly.
  for (const [t, ok] of [["MY======", true], ["MY=====", false], ["MY=======", false], ["MZXW6===", true], ["MZXW6==", false]] as Array<[string, boolean]>) {
    if (mod.b32Accepts(b(t), false) !== ok) {
      bad.push(`${JSON.stringify(t)}: ${ok ? "should be accepted" : "should be rejected"}`);
    }
  }
  if (bad.length > 0) throw new Error(bad.join("\n  "));
});

Deno.test("hex decoding is strict about length and digits", () => {
  const bad: string[] = [];
  for (const t of ["0", "abc", "0g", "0 0", "0x00", "00 ", " 00"]) {
    if (mod.hexAccepts(b(t))) bad.push(`accepted ${JSON.stringify(t)}`);
  }
  for (const t of ["", "00", "ff", "FF", "aA", "0123456789abcdefABCDEF"]) {
    if (!mod.hexAccepts(b(t))) bad.push(`rejected ${JSON.stringify(t)}`);
  }
  if (s(mod.hexDec(b("48690a"))) !== "Hi\n") bad.push("mixed decode wrong");
  if (bytes(mod.hexDec(b("aAbB"))) !== "170,187") bad.push("mixed case decode wrong");
  if (bad.length > 0) throw new Error(bad.join("\n  "));
});

Deno.test("both base64 alphabets decode either spelling", () => {
  // The 62nd and 63rd characters differ between the alphabets, and the two sets are otherwise
  // disjoint, so accepting both cannot make an input ambiguous.
  const data = new Uint8Array([0xfb, 0xef, 0xbe]);
  const std = s(mod.b64Enc(data, false, true));
  const url = s(mod.b64Enc(data, true, true));
  if (std === url) throw new Error("this input was supposed to use + and /");
  if (bytes(mod.b64Dec(b(std))) !== bytes(data)) throw new Error("standard did not decode");
  if (bytes(mod.b64Dec(b(url))) !== bytes(data)) throw new Error("url-safe did not decode");
});
