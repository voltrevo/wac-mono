// Registers the wac-side RSA key generation tests, with OpenSSL as the oracle.
//
// The interesting failures produce keys that are self-consistent: two primes that are not prime give
// a modulus we can sign and verify with all day and that factors instantly. So the host assembles a
// real RSA private key from what wac generated and runs `openssl rsa -check`, which tests primality
// of p and q, that n = p*q, and that d is the right inverse — none of which the generating side can
// establish about itself.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

const V_CHECK_KEY = 0, V_KEY_BITS = 1;

/** Read a length-prefixed field, returning the value and the next offset. */
function field(b: Uint8Array, at: number): [Uint8Array, number] {
  const len = (b[at] << 8) | b[at + 1];
  return [b.subarray(at + 2, at + 2 + len), at + 2 + len];
}

/** A DER INTEGER from a big-endian magnitude, with the sign byte and no redundant zeros. */
function derInteger(mag: Uint8Array): number[] {
  let from = 0;
  while (from + 1 < mag.length && mag[from] === 0) from++;
  const body = mag[from] >= 0x80 ? [0, ...mag.subarray(from)] : [...mag.subarray(from)];
  return [0x02, ...derLength(body.length), ...body];
}

function derLength(n: number): number[] {
  if (n < 128) return [n];
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

/**
 * A PKCS#1 RSAPrivateKey, so openssl has something to check.
 *
 * dP, dQ and qInv are computed here with BigInt. That is not a second implementation of anything
 * wac does — wac's `rsagen` does not produce them, because `rsa.wac` has no CRT path — it is the
 * host filling in fields the format requires so that `openssl rsa -check` can run.
 */
function privateKeyDer(
  n: Uint8Array, e: Uint8Array, d: Uint8Array, p: Uint8Array, q: Uint8Array,
): Uint8Array {
  const big = (b: Uint8Array) => b.reduce((acc, x) => (acc << 8n) | BigInt(x), 0n);
  const bytes = (v: bigint) => {
    let h = v.toString(16);
    if (h.length % 2) h = "0" + h;
    return Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
  };
  const P = big(p), Q = big(q), D = big(d);
  const dP = D % (P - 1n), dQ = D % (Q - 1n);
  // qInv = q^-1 mod p, by extended Euclid.
  let [oldR, r, oldS, s] = [Q % P, P, 1n, 0n];
  while (r !== 0n) {
    const quot = oldR / r;
    [oldR, r] = [r, oldR - quot * r];
    [oldS, s] = [s, oldS - quot * s];
  }
  const qInv = ((oldS % P) + P) % P;

  const body = [
    ...derInteger(new Uint8Array([0])),
    ...derInteger(n), ...derInteger(e), ...derInteger(d),
    ...derInteger(p), ...derInteger(q),
    ...derInteger(bytes(dP)), ...derInteger(bytes(dQ)), ...derInteger(bytes(qInv)),
  ];
  return new Uint8Array([0x30, ...derLength(body.length), ...body]);
}

function opensslCheck(der: Uint8Array): { code: number; out: string; err: string } {
  const b64 = btoa(String.fromCharCode(...der));
  const pem = `-----BEGIN RSA PRIVATE KEY-----\n${
    (b64.match(/.{1,64}/g) ?? []).join("\n")
  }\n-----END RSA PRIVATE KEY-----\n`;
  const file = Deno.makeTempFileSync({ prefix: "wac-rsagen-", suffix: ".pem" });
  try {
    Deno.writeTextFileSync(file, pem);
    const r = new Deno.Command("openssl", {
      args: ["rsa", "-in", file, "-check", "-noout"],
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    return {
      code: r.code,
      out: new TextDecoder().decode(r.stdout),
      err: new TextDecoder().decode(r.stderr),
    };
  } finally {
    try {
      Deno.removeSync(file);
    } catch { /* already gone */ }
  }
}

function ref(what: number, a: Uint8Array, _b: Uint8Array): Uint8Array {
  if (what === V_CHECK_KEY) {
    let at = 0;
    const [n, a1] = field(a, at);
    const [e, a2] = field(a, a1);
    const [d, a3] = field(a, a2);
    const [p, a4] = field(a, a3);
    const [q] = field(a, a4);
    const r = opensslCheck(privateKeyDer(n, e, d, p, q));
    if (r.code !== 0) {
      throw new Error(`openssl rejected the generated key:\n${r.err.trim()}\n${r.out.trim()}`);
    }
    return new Uint8Array([/RSA key ok/.test(r.out) ? 1 : 0]);
  }
  if (what === V_KEY_BITS) {
    // In 256-bit units, so it fits a byte: 1024 bits is 4.
    return new Uint8Array([Math.round((a.length * 8) / 256)]);
  }
  throw new Error(`unknown vector field ${what}`);
}

await wacTestRun("packages/crypto/test/wac/rsagen_test.wac", "rsagen", [ref]);
