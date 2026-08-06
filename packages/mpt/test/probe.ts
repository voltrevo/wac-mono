// The probe module and the flattening it forces, in one place.
//
// `test/wac/probe.wac` answers each of the three entry points as one flat `u8[]`, because bindgen marshals
// arrays and not structs — `[ok, present, len(4), value…, error…]` and its two cousins. Every test file
// needs the same unpacking, and each of them had written it out: three copies of `packNodes`, and a
// mistake in the third (the account tail is 64 bytes only when the account is *present*, and the copy
// added it unconditionally, so a refusal's message came back empty).
//
// The layout is one thing, decided in `probe.wac`, so it is decoded in one place. A test file that wants a
// different shape should change the probe rather than reinterpret its bytes.

import { wacBind } from "../../../harness/wacBind.ts";

const probe = await wacBind("packages/mpt/test/wac/probe.wac") as Record<string, unknown>;
const verifyRaw = probe.verifyProof as (root: Uint8Array, key: Uint8Array, nodes: Uint8Array) => Uint8Array;
const accountRaw = probe.verifyAccount as (r: Uint8Array, a: Uint8Array, n: Uint8Array) => Uint8Array;
const storageRaw = probe.verifyStorage as (r: Uint8Array, s: Uint8Array, n: Uint8Array) => Uint8Array;
const emptyRootsRaw = probe.emptyRoots as () => Uint8Array;

/** keccak256, from wac — `node:crypto` has no keccak, only SHA-3. See `packages/crypto`'s README. */
export const keccak = probe.hash as (b: Uint8Array) => Uint8Array;

/** The two constants `packages/mpt` claims: the empty trie root and the empty code hash, concatenated. */
export const emptyRoots = emptyRootsRaw;

export const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

const dec = new TextDecoder();

/** Length-prefixed concatenation, because bindgen marshals one array and a proof is many. */
export function packNodes(nodes: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(nodes.reduce((n, x) => n + 4 + x.length, 0));
  let at = 0;
  for (const n of nodes) {
    out[at] = n.length & 0xff;
    out[at + 1] = (n.length >> 8) & 0xff;
    out[at + 2] = (n.length >> 16) & 0xff;
    out[at + 3] = (n.length >> 24) & 0xff;
    out.set(n, at + 4);
    at += 4 + n.length;
  }
  return out;
}

export type Answer = { ok: boolean; present: boolean; value: string; error: string };

export function verify(root: Uint8Array, key: Uint8Array, nodes: Uint8Array[]): Answer {
  const out = verifyRaw(root, key, packNodes(nodes));
  const len = out[2] | (out[3] << 8) | (out[4] << 16) | (out[5] << 24);
  return {
    ok: out[0] === 1,
    present: out[1] === 1,
    value: hex(out.subarray(6, 6 + len)),
    error: dec.decode(out.subarray(6 + len)),
  };
}

export type AccountAnswer = {
  ok: boolean;
  present: boolean;
  nonce: string;
  balance: string;
  storageRoot: Uint8Array;
  codeHash: string;
  error: string;
};

export function accountAt(
  stateRoot: Uint8Array,
  address: Uint8Array,
  nodes: Uint8Array[],
): AccountAnswer {
  const out = accountRaw(stateRoot, address, packNodes(nodes));
  const nl = out[2], bl = out[3];
  const present = out[1] === 1;
  const at = 4 + nl + bl;
  return {
    ok: out[0] === 1,
    present,
    nonce: hex(out.subarray(4, 4 + nl)),
    balance: hex(out.subarray(4 + nl, at)),
    // The two 32-byte hashes are only in the answer when there is an account to have them.
    storageRoot: present ? out.slice(at, at + 32) : new Uint8Array(0),
    codeHash: present ? hex(out.subarray(at + 32, at + 64)) : "",
    error: dec.decode(out.subarray(present ? at + 64 : at)),
  };
}

export function storageAt(root: Uint8Array, slot: Uint8Array, nodes: Uint8Array[]): Answer {
  const out = storageRaw(root, slot, packNodes(nodes));
  const len = out[2] | (out[3] << 8) | (out[4] << 16) | (out[5] << 24);
  return {
    ok: out[0] === 1,
    present: out[1] === 1,
    value: hex(out.subarray(6, 6 + len)),
    error: dec.decode(out.subarray(6 + len)),
  };
}
