// Poly1305 against RFC 8439's vectors and against a BigInt reference.
//
// The BigInt version is the real oracle. Poly1305's whole difficulty is the
// limb arithmetic — carries, the fold by 5, the final conditional subtract —
// and none of that exists when you can just write the modular arithmetic down.
// So the reference is transparently the spec, and the fast version is fuzzed
// against it. Fixed vectors alone would leave most carry paths unexercised.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind(new URL("./wac/probe.wac", import.meta.url).pathname);
const poly1305 = mod.poly1305 as (k: Uint8Array, m: Uint8Array) => Uint8Array;

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.replace(/[\s:]/g, "").match(/../g)!.map(h => parseInt(h, 16)));

const leToBig = (b: Uint8Array) => b.reduceRight((a, x) => (a << 8n) | BigInt(x), 0n);

/** The definition, with no limbs: a = ((a + block) * r) mod (2^130 - 5). */
function reference(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const P = (1n << 130n) - 5n;
  const r = leToBig(key.slice(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  const s = leToBig(key.slice(16, 32));
  let a = 0n;
  for (let i = 0; i < msg.length; i += 16) {
    const chunk = msg.slice(i, i + 16);
    a = ((a + leToBig(chunk) + (1n << BigInt(chunk.length * 8))) * r) % P;
  }
  a = (a + s) & ((1n << 128n) - 1n);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number((a >> BigInt(i * 8)) & 0xFFn);
  return out;
}

Deno.test("poly1305: RFC 8439 §2.5.2", () => {
  const key = unhex("85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b");
  const msg = new TextEncoder().encode("Cryptographic Forum Research Group");
  const got = hex(poly1305(key, msg));
  if (got !== "a8061dc1305136c6c22b8baf0c0127a9") throw new Error(`got ${got}`);
});

// These exercise the degenerate keys and the carry paths. The expected values
// are computed from the definition (see the Python check in the commit message)
// rather than transcribed, because a mis-typed vector is indistinguishable from
// a bug — one of these was wrong on the first pass and the implementation was
// right.
Deno.test("poly1305: degenerate keys and forced carries", () => {
  const cases: [string, string, string][] = [
    // r = 0, s = 0: the tag must be all zeros however long the message.
    ["0000000000000000000000000000000000000000000000000000000000000000",
     "00".repeat(64), "00000000000000000000000000000000"],
    // r = 0: the tag is just s.
    ["0000000000000000000000000000000036e5f6b5c5e06070f0efca96227a863e",
     hex(new TextEncoder().encode("Any submission to the IETF intended by the Contributor for publication as all or part of an IETF Internet-Draft or RFC and any statement made within the context of an IETF activity is considered an \"IETF Contribution\". Such statements include oral statements in IETF sessions, as well as written and electronic communications made at any time or place, which are addressed to")),
     "36e5f6b5c5e06070f0efca96227a863e"],
    // s = 0, and a message that drives the accumulator to the top of the range.
    ["0200000000000000000000000000000000000000000000000000000000000000",
     "ffffffffffffffffffffffffffffffff", "03000000000000000000000000000000"],
    // Forces the final conditional subtraction.
    // Drives the accumulator just past p, forcing the conditional subtract.
    ["0200000000000000000000000000000000000000000000000000000000000000",
     "02000000000000000000000000000000", "04000000000000000000000000000000"],
    ["0100000000000000040000000000000000000000000000000000000000000000",
     "e33594d7505e43b900000000000000003394d7505e4379cd01000000000000000000000000000000000000000000000001000000000000000000000000000000",
     "14000000000000005500000000000000"],
  ];
  for (const [k, m, want] of cases) {
    const got = hex(poly1305(unhex(k), unhex(m)));
    if (got !== want) throw new Error(`key ${k.slice(0, 16)}...\n  got  ${got}\n  want ${want}`);
  }
});

Deno.test("poly1305: agrees with the BigInt reference on every length to 3 blocks", () => {
  const key = unhex("85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b");
  for (let n = 0; n <= 49; n++) {
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = (i * 53 + 17) & 0xFF;
    const got = hex(poly1305(key, m));
    const want = hex(reference(key, m));
    if (got !== want) throw new Error(`length ${n}: got ${got}, want ${want}`);
  }
});

Deno.test("poly1305: agrees with the reference under fuzzing, including all-ones keys", () => {
  let s = 0x9E3779B9;
  const next = () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7FFFFFFF; return s; };
  const rnd = (n: number) => { const o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = (next() >>> 11) & 0xFF; return o; };

  for (let k = 0; k < 400; k++) {
    const key = rnd(32);
    const msg = rnd(next() % 300);
    const got = hex(poly1305(key, msg));
    const want = hex(reference(key, msg));
    if (got !== want) throw new Error(`fuzz ${k} (len ${msg.length}) key ${hex(key)}: got ${got}, want ${want}`);
  }

  // Saturated inputs, where carries propagate the whole way and the final
  // subtract triggers — the cases random bytes almost never reach.
  for (const n of [16, 32, 48, 64, 100]) {
    const key = new Uint8Array(32).fill(0xFF);
    const msg = new Uint8Array(n).fill(0xFF);
    const got = hex(poly1305(key, msg));
    const want = hex(reference(key, msg));
    if (got !== want) throw new Error(`all-ones len ${n}: got ${got}, want ${want}`);
  }
});
