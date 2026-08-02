// X25519MLKEM768, tested directly rather than through a handshake.
//
// The hybrid was already exercised — `client.test.ts` negotiates it against an OpenSSL
// 3.5.7 server that will accept nothing else, which is a strong end-to-end check and the
// reason the concatenation order is known to be right. What it is not is a check of any
// individual thing this file does. A whole successful handshake asserts one bit: the two
// sides agreed. Every length guard, every rejection, and the order of the two halves are
// invisible to it, and mutation testing said so — all eight of hybrid.wac's guards
// survived, along with all four of its constants.
//
// The parts worth pinning separately:
//
//   the lengths     1216 offered, 1120 returned, 64 shared. Getting one wrong breaks the
//                   handshake loudly, so the interop test covers them — but only for the
//                   values OpenSSL also uses, and only while that test is runnable.
//   the order       ML-KEM first for this group, X25519 first for SecP256r1MLKEM768. Two
//                   hybrids in one draft, ordered differently.
//   both halves     a secret that ignores one of its two inputs is the failure the whole
//                   construction exists to prevent, and it interoperates perfectly with
//                   itself.
//   the guards      wrong-length inputs, which nothing reached before.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/tls/test/wac/probe.wac");
const offer = mod.hybOffer as (kemSeed: Uint8Array, xPriv: Uint8Array) => Uint8Array;
const accept = mod.hybAccept as (share: Uint8Array, m: Uint8Array, xPriv: Uint8Array) => Uint8Array;
const finish = mod.hybFinish as (offer: Uint8Array, share: Uint8Array, xPriv: Uint8Array) => Uint8Array;

const GROUP = (mod.hybGroup as () => number)();
const CLIENT_SHARE = (mod.hybClientLen as () => number)();
const SERVER_SHARE = (mod.hybServerLen as () => number)();
const SECRET = (mod.hybSecretLen as () => number)();
const DK = 2400;

const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
const traps = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
const bytes = (n: number, seed = 0) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xFF);

Deno.test("hybrid: the code point and the three lengths", () => {
  // Read from the source rather than repeated here, so this is a check that the numbers
  // are what the draft says and not a copy that agrees with itself.
  if (GROUP !== 0x11EC) throw new Error(`group is 0x${GROUP.toString(16)}, want 0x11ec`);
  if (CLIENT_SHARE !== 1184 + 32) throw new Error(`client share ${CLIENT_SHARE}`);
  if (SERVER_SHARE !== 1088 + 32) throw new Error(`server share ${SERVER_SHARE}`);
  if (SECRET !== 32 + 32) throw new Error(`secret ${SECRET}`);
});

Deno.test("hybrid: both sides reach the same secret", () => {
  const kemSeed = bytes(64, 1);
  const cPriv = bytes(32, 2);
  const sPriv = bytes(32, 3);
  const m = bytes(32, 4);

  const off = offer(kemSeed, cPriv);
  if (off.length !== CLIENT_SHARE + DK) throw new Error(`offer is ${off.length} bytes`);

  const acc = accept(off.subarray(0, CLIENT_SHARE), m, sPriv);
  if (acc.length !== SERVER_SHARE + SECRET) throw new Error(`accept is ${acc.length} bytes`);

  const serverSecret = acc.subarray(SERVER_SHARE);
  const clientSecret = finish(off, acc.subarray(0, SERVER_SHARE), cPriv);
  if (clientSecret.length !== SECRET) throw new Error(`finish is ${clientSecret.length} bytes`);
  if (hex(clientSecret) !== hex(serverSecret)) {
    throw new Error(`the two sides disagree\n  client ${hex(clientSecret)}\n  server ${hex(serverSecret)}`);
  }
});

Deno.test("hybrid: the secret depends on both halves, not just one", () => {
  // The property the construction exists for. A build that concatenated the ML-KEM secret
  // with a constant, or that dropped the X25519 half, would agree with itself perfectly
  // and pass the test above — and would be exactly as strong as its weaker half.
  const kemSeed = bytes(64, 5);
  const cPriv = bytes(32, 6);
  const sPriv = bytes(32, 7);
  const m = bytes(32, 8);

  const base = (() => {
    const off = offer(kemSeed, cPriv);
    const acc = accept(off.subarray(0, CLIENT_SHARE), m, sPriv);
    return { off, acc, secret: hex(acc.subarray(SERVER_SHARE)) };
  })();

  // Change only the ML-KEM randomness: the first 32 bytes of the secret must move and
  // the X25519 half must not, because neither private key changed.
  const otherM = accept(base.off.subarray(0, CLIENT_SHARE), bytes(32, 9), sPriv);
  const a = base.acc.subarray(SERVER_SHARE), b = otherM.subarray(SERVER_SHARE);
  if (hex(a.subarray(0, 32)) === hex(b.subarray(0, 32))) {
    throw new Error("a different ML-KEM message gave the same first half");
  }
  if (hex(a.subarray(32)) !== hex(b.subarray(32))) {
    throw new Error("the X25519 half moved when only the ML-KEM message changed");
  }

  // Change only the server's X25519 key: the second half must move and the first must not.
  const otherX = accept(base.off.subarray(0, CLIENT_SHARE), m, bytes(32, 10));
  const c = otherX.subarray(SERVER_SHARE);
  if (hex(a.subarray(32)) === hex(c.subarray(32))) {
    throw new Error("a different X25519 key gave the same second half");
  }
  if (hex(a.subarray(0, 32)) !== hex(c.subarray(0, 32))) {
    throw new Error("the ML-KEM half moved when only the X25519 key changed");
  }
});

Deno.test("hybrid: ML-KEM comes first, in both directions", () => {
  // The order is a fact about the registry rather than a principle — SecP256r1MLKEM768
  // puts its ECDHE half first — so it is worth pinning positionally rather than trusting
  // that a round trip which agrees with itself has it right.
  const kemSeed = bytes(64, 11);
  const cPriv = bytes(32, 12);
  const off = offer(kemSeed, cPriv);

  // The client share's last 32 bytes are the X25519 public key, so the first 1184 are the
  // encapsulation key. Two offers differing only in the X25519 scalar must agree on
  // everything except that tail.
  const other = offer(kemSeed, bytes(32, 13));
  if (hex(off.subarray(0, 1184)) !== hex(other.subarray(0, 1184))) {
    throw new Error("changing the X25519 scalar moved the ML-KEM half; the order is wrong");
  }
  if (hex(off.subarray(1184, CLIENT_SHARE)) === hex(other.subarray(1184, CLIENT_SHARE))) {
    throw new Error("changing the X25519 scalar did not move the X25519 half");
  }

  // Same on the server side: the ciphertext is first, the public key last.
  const sPriv = bytes(32, 14);
  const a = accept(off.subarray(0, CLIENT_SHARE), bytes(32, 15), sPriv);
  const b = accept(off.subarray(0, CLIENT_SHARE), bytes(32, 15), bytes(32, 16));
  if (hex(a.subarray(0, 1088)) !== hex(b.subarray(0, 1088))) {
    throw new Error("changing the server's X25519 key moved the ciphertext");
  }
  if (hex(a.subarray(1088, SERVER_SHARE)) === hex(b.subarray(1088, SERVER_SHARE))) {
    throw new Error("changing the server's X25519 key did not move its public key");
  }
});

Deno.test("hybrid: a tampered server share yields a different secret, not an error", () => {
  // ML-KEM's implicit rejection carried up to the hybrid. Decapsulating a bad ciphertext
  // must return some other secret rather than reporting failure — reporting it would be a
  // decryption oracle — so a tampered share surfaces as a Finished that does not verify.
  const kemSeed = bytes(64, 17);
  const cPriv = bytes(32, 18);
  const off = offer(kemSeed, cPriv);
  const acc = accept(off.subarray(0, CLIENT_SHARE), bytes(32, 19), bytes(32, 20));
  const good = hex(finish(off, acc.subarray(0, SERVER_SHARE), cPriv));

  for (const i of [0, 1087, 1088, SERVER_SHARE - 1]) {
    const bad = Uint8Array.from(acc.subarray(0, SERVER_SHARE));
    bad[i] ^= 1;
    let got: string;
    try {
      got = hex(finish(off, bad, cPriv));
    } catch {
      throw new Error(`tampering at byte ${i} threw; implicit rejection must not report failure`);
    }
    if (got === good) throw new Error(`tampering at byte ${i} left the secret unchanged`);
  }
});

Deno.test("hybrid: every input length is checked, long as well as short", () => {
  // Eight guards, none of which anything reached: the hybrid was only ever driven through
  // whole handshakes, where the lengths are right by construction. Short inputs would
  // mostly trap anyway on a read past the end; long ones would have their tails silently
  // ignored.
  const kemSeed = bytes(64, 21);
  const cPriv = bytes(32, 22);
  const off = offer(kemSeed, cPriv);
  const share = off.subarray(0, CLIENT_SHARE);
  const acc = accept(share, bytes(32, 23), bytes(32, 24));
  const sShare = acc.subarray(0, SERVER_SHARE);

  for (const n of [0, 63, 65, 128]) {
    if (!traps(() => offer(bytes(n), cPriv))) throw new Error(`offer accepted a ${n}-byte seed`);
  }
  for (const n of [0, 31, 33]) {
    if (!traps(() => offer(kemSeed, bytes(n)))) throw new Error(`offer accepted a ${n}-byte scalar`);
    if (!traps(() => accept(share, bytes(32), bytes(n)))) throw new Error(`accept took a ${n}-byte scalar`);
    if (!traps(() => accept(share, bytes(n), cPriv))) throw new Error(`accept took a ${n}-byte message`);
    if (!traps(() => finish(off, sShare, bytes(n)))) throw new Error(`finish took a ${n}-byte scalar`);
  }
  for (const n of [0, CLIENT_SHARE - 1, CLIENT_SHARE + 1]) {
    if (!traps(() => accept(bytes(n), bytes(32), cPriv))) throw new Error(`accept took a ${n}-byte share`);
  }
  for (const n of [0, SERVER_SHARE - 1, SERVER_SHARE + 1]) {
    if (!traps(() => finish(off, bytes(n), cPriv))) throw new Error(`finish took a ${n}-byte share`);
  }
  for (const n of [0, CLIENT_SHARE + DK - 1, CLIENT_SHARE + DK + 1]) {
    if (!traps(() => finish(bytes(n), sShare, cPriv))) throw new Error(`finish took a ${n}-byte offer`);
  }

  // And the genuine lengths still work, so the guards are rejecting the odd ones out.
  if (finish(off, sShare, cPriv).length !== SECRET) throw new Error("the genuine call broke");
});
