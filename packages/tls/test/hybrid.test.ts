// X25519MLKEM768's length refusals.
//
// Only the refusals. Everything else — the code point and lengths, both sides agreeing,
// each half depending on its own input, ML-KEM's share coming first, implicit rejection —
// is in `test/wac/hybrid_test.wac`, because none of it needs a host: every property is a
// relation between the hybrid's own outputs rather than a value somebody else supplies.
//
// These stayed because a wrong length traps, and a trap unwinds the module rather than
// returning, so wac cannot assert one. Eight guards, none of which anything reached until
// today: the hybrid was only ever driven through whole handshakes, where the lengths are
// right by construction.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/tls/test/wac/probe.wac");
const offer = mod.hybOffer as (kemSeed: Uint8Array, xPriv: Uint8Array) => Uint8Array;
const accept = mod.hybAccept as (share: Uint8Array, m: Uint8Array, xPriv: Uint8Array) => Uint8Array;
const finish = mod.hybFinish as (offer: Uint8Array, share: Uint8Array, xPriv: Uint8Array) => Uint8Array;

const CLIENT_SHARE = (mod.hybClientLen as () => number)();
const SERVER_SHARE = (mod.hybServerLen as () => number)();
const SECRET = (mod.hybSecretLen as () => number)();
const DK = 2400;

const traps = (f: () => unknown) => { try { f(); return false; } catch { return true; } };
const bytes = (n: number, seed = 0) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xFF);

Deno.test("hybrid: every input length is checked, long as well as short", () => {
  // Both sides of each guard. A short input would mostly trap anyway on a read past the
  // end; a long one has its tail silently ignored, which is the half nothing tested.
  const kemSeed = bytes(64, 21);
  const cPriv = bytes(32, 22);
  const off = offer(kemSeed, cPriv);
  const share = off.subarray(0, CLIENT_SHARE);
  const sShare = accept(share, bytes(32, 23), bytes(32, 24)).subarray(0, SERVER_SHARE);

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

  // And the genuine lengths still work, so the guards are rejecting the odd ones out
  // rather than everything.
  if (finish(off, sShare, cPriv).length !== SECRET) throw new Error("the genuine call broke");
});
