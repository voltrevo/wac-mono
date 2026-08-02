// Registers the wac-side P-256 and P-384 tests and supplies node's ECDSA.
//
// The only real work here is converting the signature between DER — which X.509 and node
// both use — and the raw r||s the crypto layer wants. That conversion belongs on this side
// because it is exactly where the two conventions meet, and getting it wrong here would
// look like a curve bug.
import {
  createPrivateKey, createPublicKey, createSign, createVerify, generateKeyPairSync,
} from "node:crypto";
import { Buffer } from "node:buffer";
import { wacTestRun } from "../../../harness/wacTestRun.ts";

const SIGN = 0, VERIFY = 1, PUBKEY = 2;
const P = {
  256: { hash: "sha256", n: 32, pkcs8: "308187020100301306072a8648ce3d020106082a8648ce3d030107046d306b0201010420", tail: "a14403420004" },
  384: { hash: "sha384", n: 48, pkcs8: "3081b6020100301006072a8648ce3d020106052b8104002204819e30819b0201010430", tail: "a16403620004" },
} as const;

/** DER SEQUENCE{INTEGER r, INTEGER s} from raw r||s. */
function rawToDer(raw: Uint8Array): Buffer {
  const n = raw.length / 2;
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const body = b.subarray(i);
    const lead = body[0] & 0x80 ? Uint8Array.from([0, ...body]) : body;
    return Buffer.concat([Buffer.from([0x02, lead.length]), Buffer.from(lead)]);
  };
  const body = Buffer.concat([int(raw.subarray(0, n)), int(raw.subarray(n))]);
  const head = body.length < 0x80
    ? Buffer.from([0x30, body.length])
    : Buffer.from([0x30, 0x81, body.length]);
  return Buffer.concat([head, body]);
}

/** Raw r||s from DER, left-padded — a shorter r is the same number, not a smaller one. */
function derToRaw(d: Uint8Array, n: number): Uint8Array {
  let i = d[1] & 0x80 ? 3 : 2;
  const out = new Uint8Array(2 * n);
  for (const half of [0, 1]) {
    i++;
    const len = d[i++];
    let v = d.subarray(i, i + len);
    i += len;
    while (v.length > n) v = v.subarray(1);
    out.set(v, half * n + n - v.length);
  }
  return out;
}

const privKey = (curve: 256 | 384, scalar: Uint8Array, pub: Uint8Array) =>
  createPrivateKey({
    key: Buffer.concat([
      Buffer.from(P[curve].pkcs8, "hex"), Buffer.from(scalar),
      // Both tails carry the uncompressed-point marker themselves, so the raw point is
      // appended without its leading 0x04 — the lengths in the header count on that.
      Buffer.from(P[curve].tail, "hex"), Buffer.from(pub.subarray(1)),
    ]),
    format: "der", type: "pkcs8",
  });

function ref(mode: number, curve: number, a: Uint8Array, b: Uint8Array): Uint8Array {
  const c = curve as 256 | 384;
  const { hash, n } = P[c];
  if (mode === PUBKEY) {
    // A fresh keypair, returned as scalar || point. node has no "scalar to point" call —
    // it refuses a SEC1 key without the public half — so the host picks the key and wac
    // must reproduce its public part. That is the stronger direction anyway: the key is
    // not one we chose.
    const kp = generateKeyPairSync("ec", { namedCurve: c === 256 ? "prime256v1" : "secp384r1" });
    const spki = kp.publicKey.export({ type: "spki", format: "der" }) as Buffer;
    const pkcs8 = kp.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
    const point = new Uint8Array(spki.subarray(-(2 * n + 1)));
    // The scalar sits in the SEC1 OCTET STRING; find it by its length prefix rather than
    // at a fixed offset, since the P-384 wrapper is a different size.
    let i = pkcs8.indexOf(0x04);
    while (!(pkcs8[i] === 0x04 && pkcs8[i + 1] === n)) i = pkcs8.indexOf(0x04, i + 1);
    const scalar = new Uint8Array(pkcs8.subarray(i + 2, i + 2 + n));
    return new Uint8Array([...scalar, ...point]);
  }
  if (mode === SIGN) {
    const scalar = a.subarray(0, n);
    const pub = a.subarray(n);
    const s = createSign(hash);
    s.update(b);
    return derToRaw(s.sign(privKey(c, scalar, pub)), n);
  }
  const pub = a.subarray(0, 2 * n + 1);
  const sig = a.subarray(2 * n + 1);
  const v = createVerify(hash);
  v.update(b);
  const spki = Buffer.concat([
    Buffer.from(c === 256
      ? "3059301306072a8648ce3d020106082a8648ce3d030107034200"
      : "3076301006072a8648ce3d020106052b8104002203620004", "hex"),
    Buffer.from(c === 256 ? pub : pub.subarray(1)),
  ]);
  const ok = v.verify(createPublicKey({ key: spki, format: "der", type: "spki" }), rawToDer(sig));
  return Uint8Array.from([ok ? 1 : 0]);
}

await wacTestRun("packages/crypto/test/wac/nistcurve_test.wac", "nistcurve", [ref]);
