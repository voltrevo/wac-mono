// The TLS 1.3 key schedule, against RFC 8448's trace and an independent HKDF.
//
// Two oracles, because they cover different failures. The independent HKDF-Expand-Label
// below — built on WebCrypto's HMAC, and deliberately not sharing a line with the wac
// side — catches an error in the info-field encoding for any label, length or context.
// RFC 8448's published trace catches an error in the *chain*: the right primitive
// applied to the wrong secret, or with the wrong transcript, which no amount of
// per-operation agreement would show.
//
// A note on the vectors. Several were written from memory first and two of the four were
// wrong; they are here only because the implementation and the independent reference
// both agreed against them and forced a re-check. Where the trace and the reference
// disagreed, the reference won and the recalled value was dropped rather than adjusted
// to fit — which is the only way round that is worth anything.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/tls/test/wac/probe.wac");
const expandLabel = mod.tlsExpandLabel as (s: Uint8Array, l: Uint8Array, c: Uint8Array, n: number) => Uint8Array;
const deriveSecret = mod.tlsDeriveSecret as (s: Uint8Array, l: Uint8Array, t: Uint8Array) => Uint8Array;
const earlySecret = mod.tlsEarlySecret as (psk: Uint8Array) => Uint8Array;
const handshakeSecret = mod.tlsHandshakeSecret as (e: Uint8Array, d: Uint8Array) => Uint8Array;
const masterSecret = mod.tlsMasterSecret as (h: Uint8Array) => Uint8Array;
const trafficKeyIv = mod.tlsTrafficKeyIv as (s: Uint8Array, n: number) => Uint8Array;
const finishedVerify = mod.tlsFinishedVerify as (b: Uint8Array, t: Uint8Array) => Uint8Array;
const nextTrafficSecret = mod.tlsNextTrafficSecret as (s: Uint8Array) => Uint8Array;
const emptyHash = mod.tlsEmptyHash as () => Uint8Array;

const enc = new TextEncoder();
const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.replace(/\s/g, "").match(/../g)!.map(h => parseInt(h, 16)));

/**
 * HKDF-Expand-Label, written out independently on WebCrypto's HMAC.
 *
 * WebCrypto exposes HKDF only as extract-then-expand, and the key schedule needs expand
 * on its own, so the RFC 5869 expand loop is spelled out here. That is a feature rather
 * than a nuisance: an oracle assembled from a different primitive is worth more than one
 * that calls the same function the code under test does.
 */
async function refExpandLabel(secret: Uint8Array, label: string, ctx: Uint8Array, len: number): Promise<Uint8Array> {
  const full = enc.encode("tls13 " + label);
  const info = new Uint8Array(2 + 1 + full.length + 1 + ctx.length);
  info[0] = (len >> 8) & 0xFF;
  info[1] = len & 0xFF;
  info[2] = full.length;
  info.set(full, 3);
  info[3 + full.length] = ctx.length;
  info.set(ctx, 4 + full.length);

  const hk = await crypto.subtle.importKey(
    "raw", secret as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const out = new Uint8Array(len);
  let prev = new Uint8Array(0);
  for (let i = 0, n = 1; i < len; n++) {
    const input = new Uint8Array(prev.length + info.length + 1);
    input.set(prev);
    input.set(info, prev.length);
    input[input.length - 1] = n;
    prev = new Uint8Array(await crypto.subtle.sign("HMAC", hk, input as BufferSource));
    out.set(prev.subarray(0, Math.min(prev.length, len - i)), i);
    i += prev.length;
  }
  return out;
}

Deno.test("keyschedule: HKDF-Expand-Label agrees with an independent implementation", async () => {
  const secret = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xFF);
  const cases: [string, number, number][] = [
    // Every label the schedule actually uses, plus the shapes around them: an empty
    // context, a hash-length context, a one-byte output and a multi-block one.
    ["derived", 32, 32], ["c hs traffic", 32, 32], ["s hs traffic", 32, 32],
    ["c ap traffic", 32, 32], ["s ap traffic", 32, 32], ["res master", 32, 32],
    ["key", 0, 16], ["key", 0, 32], ["iv", 0, 12], ["finished", 0, 32],
    ["traffic upd", 0, 32],
    ["x", 0, 1], ["x", 0, 255],
    // A label at the encoding's limit: "tls13 " plus 249 characters is 255 bytes, the
    // most the one-byte length prefix can express.
    ["y".repeat(249), 0, 32],
    ["mid", 255, 32],
  ];
  for (const [label, ctxLen, len] of cases) {
    const ctx = Uint8Array.from({ length: ctxLen }, (_, i) => (i * 13 + 1) & 0xFF);
    const got = hex(expandLabel(secret, enc.encode(label), ctx, len));
    const want = hex(await refExpandLabel(secret, label, ctx, len));
    if (got !== want) {
      throw new Error(`label ${JSON.stringify(label.slice(0, 20))} ctx=${ctxLen} len=${len}\n  got  ${got}\n  want ${want}`);
    }
  }
});

Deno.test("keyschedule: the RFC 8448 chain, from shared secret to traffic secrets", () => {
  // RFC 8448 §3, the simple 1-RTT handshake. Each value here was checked against the
  // published trace; the ones that did not match were removed rather than kept.
  const shared = unhex("8bd4054fb55b9d63fdfbacf9f04b9f0d35e6d63f537563efd46272900f89492d");
  const transcriptCHSH = unhex("860c06edc07858ee8e78f0e7428c58edd6b43f2ca3e6e95f02ed063cf0e1cad8");

  const early = earlySecret(new Uint8Array(32));
  if (hex(early) !== "33ad0a1c607ec03b09e6cd9893680ce210adf300aa1f2660e1b22e10f170f92a") {
    throw new Error(`early secret: ${hex(early)}`);
  }
  const hs = handshakeSecret(early, shared);
  if (hex(hs) !== "1dc826e93606aa6fdc0aadc12f741b01046aa6b99f691ed221a9f0ca043fbeac") {
    throw new Error(`handshake secret: ${hex(hs)}`);
  }
  const clientHs = deriveSecret(hs, enc.encode("c hs traffic"), transcriptCHSH);
  if (hex(clientHs) !== "b3eddb126e067f35a780b3abf45e2d8f3b1a950738f52e9600746a0e27a55a21") {
    throw new Error(`client handshake traffic secret: ${hex(clientHs)}`);
  }
  const serverHs = deriveSecret(hs, enc.encode("s hs traffic"), transcriptCHSH);
  if (hex(serverHs) !== "b67b7d690cc16c4e75e54213cb2d37b4e9c912bcded9105d42befd59d391ad38") {
    throw new Error(`server handshake traffic secret: ${hex(serverHs)}`);
  }
});

Deno.test("keyschedule: traffic keys and IVs, against the independent reference", async () => {
  // Derived from a secret the RFC 8448 test above has already pinned, so a failure here
  // is in the key derivation rather than anywhere upstream of it.
  const serverHs = unhex("b67b7d690cc16c4e75e54213cb2d37b4e9c912bcded9105d42befd59d391ad38");
  for (const keyLen of [16, 32]) {
    const got = hex(trafficKeyIv(serverHs, keyLen));
    const want = hex(await refExpandLabel(serverHs, "key", new Uint8Array(0), keyLen)) +
      hex(await refExpandLabel(serverHs, "iv", new Uint8Array(0), 12));
    if (got !== want) throw new Error(`keyLen ${keyLen}\n  got  ${got}\n  want ${want}`);
  }
});

Deno.test("keyschedule: the empty-context hash is SHA-256 of nothing", async () => {
  const want = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(0)));
  if (hex(emptyHash()) !== hex(want)) throw new Error(`emptyHash: ${hex(emptyHash())}`);
});

Deno.test("keyschedule: every derivation depends on everything it should", () => {
  // The chain's whole purpose is that a secret binds to the transcript and to the key
  // exchange. These check that it does — a derivation that ignored its context, or an
  // extract that ignored its salt, would still produce plausible 32-byte secrets and
  // would interoperate with nobody.
  const early = earlySecret(new Uint8Array(32));
  const dhe1 = Uint8Array.from({ length: 32 }, (_, i) => i);
  const dhe2 = Uint8Array.from({ length: 32 }, (_, i) => i === 0 ? 99 : i);
  if (hex(handshakeSecret(early, dhe1)) === hex(handshakeSecret(early, dhe2))) {
    throw new Error("the handshake secret ignored the shared secret");
  }

  const hs = handshakeSecret(early, dhe1);
  const th1 = Uint8Array.from({ length: 32 }, (_, i) => (i * 3) & 0xFF);
  const th2 = Uint8Array.from(th1);
  th2[31] ^= 1;
  if (hex(deriveSecret(hs, enc.encode("c hs traffic"), th1)) ===
      hex(deriveSecret(hs, enc.encode("c hs traffic"), th2))) {
    throw new Error("a derived secret ignored the transcript hash");
  }
  if (hex(deriveSecret(hs, enc.encode("c hs traffic"), th1)) ===
      hex(deriveSecret(hs, enc.encode("s hs traffic"), th1))) {
    throw new Error("client and server secrets came out equal");
  }
  if (hex(masterSecret(hs)) === hex(hs)) throw new Error("the master secret is the handshake secret");

  // A KeyUpdate must move the secret, and must not be reversible by repeating.
  const next = nextTrafficSecret(hs);
  if (hex(next) === hex(hs)) throw new Error("traffic update returned the same secret");
  if (hex(nextTrafficSecret(next)) === hex(hs)) throw new Error("two updates returned to the start");
});

Deno.test("keyschedule: Finished binds to the transcript and to the sender", async () => {
  const base = unhex("b67b7d690cc16c4e75e54213cb2d37b4e9c912bcded9105d42befd59d391ad38");
  const th = Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 2) & 0xFF);

  // verify_data is HMAC(HKDF-Expand-Label(base, "finished", "", 32), transcript).
  const fk = await refExpandLabel(base, "finished", new Uint8Array(0), 32);
  const hk = await crypto.subtle.importKey("raw", fk as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = new Uint8Array(await crypto.subtle.sign("HMAC", hk, th as BufferSource));
  if (hex(finishedVerify(base, th)) !== hex(want)) {
    throw new Error(`verify_data\n  got  ${hex(finishedVerify(base, th))}\n  want ${hex(want)}`);
  }

  const th2 = Uint8Array.from(th);
  th2[0] ^= 1;
  if (hex(finishedVerify(base, th)) === hex(finishedVerify(base, th2))) {
    throw new Error("verify_data ignored the transcript");
  }
  const other = Uint8Array.from(base);
  other[0] ^= 1;
  if (hex(finishedVerify(base, th)) === hex(finishedVerify(other, th))) {
    throw new Error("verify_data ignored the base key");
  }
});

Deno.test("keyschedule: rejects labels and contexts the encoding cannot express", () => {
  const traps = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
  const secret = new Uint8Array(32);
  // "tls13 " plus 250 characters is 256, one past what the length byte holds.
  if (!traps(() => expandLabel(secret, enc.encode("z".repeat(250)), new Uint8Array(0), 32))) {
    throw new Error("accepted a label longer than the encoding allows");
  }
  if (!traps(() => expandLabel(secret, enc.encode("key"), new Uint8Array(256), 32))) {
    throw new Error("accepted a context longer than the encoding allows");
  }
  // And the largest that does fit must still work, or the bound is off by one.
  expandLabel(secret, enc.encode("z".repeat(249)), new Uint8Array(255), 32);
});
