// The key schedule's encoding limits.
//
// Only the refusals. The RFC 8448 chain, HKDF-Expand-Label against an independent HMAC,
// the traffic keys, and the "every derivation depends on everything it should" checks all
// moved to `test/wac/keyschedule_test.wac` — none of them needed a host once the HMAC
// could be passed in as a callback.
//
// These stayed because they trap, and a trap unwinds the module rather than returning, so
// wac cannot assert one. The bound matters: HKDF-Expand-Label writes the label and the
// context each behind a one-byte length, so a label of 256 bytes silently becomes a label
// of zero if the length is truncated rather than refused, and every peer derives a
// different key from the one we do.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/tls/test/wac/probe.wac");
const expandLabel = mod.tlsExpandLabel as
  (secret: Uint8Array, label: Uint8Array, ctx: Uint8Array, len: number) => Uint8Array;

const enc = new TextEncoder();

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
