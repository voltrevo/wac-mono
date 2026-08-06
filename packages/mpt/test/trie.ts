// A Merkle-Patricia trie, in TypeScript, whose only job is to be an oracle.
//
// The wac side verifies proofs; something has to produce them. This builds a trie the way Ethereum does and
// hands out the node path for a key — and it is *itself* checked against Ethereum's published roots before
// any proof it emits is believed. That ordering is the point: a builder and a verifier written by the same
// hand agree with each other for free, so the builder is anchored to seven roots from `ethereum/tests`
// first, and only then used as a source of inputs.
//
// **Insert-only.** Deletion is where a Patricia trie gets hard — a branch that loses its second-to-last
// child collapses back into an extension, and getting that wrong changes the root — and no proof needs it: a
// proof is a path through a trie that already exists. `trieanyorder.json` is the insert-only fixture set for
// the same reason, and `trietest.json`'s deletion cases are deliberately not used.
//
// Node shapes, all RLP:
//
//   leaf      [ hp(path, leaf: true), value ]
//   extension [ hp(path, leaf: false), child ]
//   branch    [ c0, c1, … c15, value ]        — seventeen items, empty string for an absent child
//
// A child is the node *inline* when its RLP is under 32 bytes and `keccak256(rlp(node))` otherwise, which is
// why a proof cannot simply be "the nodes on the path": an inline child has no hash to check, so a verifier
// has to handle both forms. Several of the fixtures below have inline children, which is what makes them
// worth having.

import { rlpEncode, type RlpItem } from "./rlp.ts";

/** The tree, kept as nodes rather than as encodings, so a walk can follow it after hashing. */
export type Tree =
  | { kind: "leaf"; path: number[]; value: Uint8Array }
  | { kind: "ext"; path: number[]; child: Tree }
  | { kind: "branch"; slots: (Tree | null)[]; value: Uint8Array };

/** Key bytes to nibbles, high nibble first. */
export function nibbles(key: Uint8Array): number[] {
  const out: number[] = [];
  for (const b of key) out.push(b >> 4, b & 15);
  return out;
}

/**
 * Hex-prefix encoding: a path's nibbles as bytes, behind a flag nibble.
 *
 * The flag carries two bits — leaf or extension, and whether the nibble count is odd — and the odd case is
 * why it exists at all: nibbles do not divide into bytes, so a path of odd length has to say so somewhere.
 * An even path gets a zero nibble of padding after the flag.
 */
export function hp(path: number[], leaf: boolean): Uint8Array {
  const flag = (leaf ? 2 : 0) | (path.length & 1);
  const ns = (path.length & 1) === 1 ? [flag, ...path] : [flag, 0, ...path];
  const out = new Uint8Array(ns.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = (ns[2 * i] << 4) | ns[2 * i + 1];
  return out;
}

type Entry = { path: number[]; value: Uint8Array };

function build(entries: Entry[], at: number): Tree {
  if (entries.length === 1) {
    return { kind: "leaf", path: entries[0].path.slice(at), value: entries[0].value };
  }
  // The longest prefix every entry shares from `at`: a shared prefix is an extension, and no shared prefix
  // means the entries differ immediately, which is a branch.
  let end = at;
  outer: for (;; end++) {
    const first = entries[0].path;
    if (end >= first.length) break;
    for (const e of entries) if (end >= e.path.length || e.path[end] !== first[end]) break outer;
  }
  if (end > at) {
    return { kind: "ext", path: entries[0].path.slice(at, end), child: build(entries, end) };
  }
  const slots: (Tree | null)[] = Array.from({ length: 16 }, () => null);
  let value: Uint8Array = new Uint8Array(0);
  const groups = new Map<number, Entry[]>();
  for (const e of entries) {
    if (e.path.length === at) {
      value = e.value;
      continue;
    }
    const n = e.path[at];
    if (!groups.has(n)) groups.set(n, []);
    groups.get(n)!.push(e);
  }
  for (const [n, group] of groups) slots[n] = build(group, at + 1);
  return { kind: "branch", slots, value };
}

export type Hasher = (bytes: Uint8Array) => Uint8Array;

/** A node's RLP, with each child replaced by its reference. */
export function nodeRlp(t: Tree, keccak: Hasher): Uint8Array {
  return rlpEncode(shape(t, keccak));
}

function shape(t: Tree, keccak: Hasher): RlpItem {
  if (t.kind === "leaf") return [hp(t.path, true), t.value];
  if (t.kind === "ext") return [hp(t.path, false), ref(t.child, keccak)];
  return [...t.slots.map((s) => (s === null ? new Uint8Array(0) : ref(s, keccak))), t.value];
}

/** What a parent stores for a child: the node inline under 32 bytes, its hash at or above. */
function ref(t: Tree, keccak: Hasher): RlpItem {
  const bytes = nodeRlp(t, keccak);
  return bytes.length < 32 ? shape(t, keccak) : keccak(bytes);
}

export type Trie = {
  root: Uint8Array;
  /** Every node from the root to where the key's path stops — the proof, in order. */
  proof(key: Uint8Array): Uint8Array[];
};

export function trie(pairs: [Uint8Array, Uint8Array][], keccak: Hasher): Trie {
  // An empty trie's root is `keccak256(rlp(""))`, the constant every empty account carries.
  if (pairs.length === 0) {
    return { root: keccak(rlpEncode(new Uint8Array(0))), proof: () => [] };
  }
  const root = build(pairs.map(([k, v]) => ({ path: nibbles(k), value: v })), 0);
  return {
    root: keccak(nodeRlp(root, keccak)),
    proof(key: Uint8Array): Uint8Array[] {
      const path = nibbles(key);
      const out: Uint8Array[] = [];
      let node: Tree = root;
      let at = 0;
      // Only the nodes a *hash* points at, which is what `eth_getProof` returns: a child whose RLP is
      // under 32 bytes is embedded in its parent, so listing it again would be listing the same bytes
      // twice. The root always counts, since the state root is a hash by definition.
      let hashed = true;
      for (;;) {
        if (hashed) out.push(nodeRlp(node, keccak));
        if (node.kind === "leaf") return out;
        if (node.kind === "ext") {
          // A path that diverges from the extension's own stops here, and that node is the proof of
          // absence: it says what the trie has at this prefix, and it is not what was asked for.
          const own = node.path;
          for (let i = 0; i < own.length; i++) {
            if (at + i >= path.length || path[at + i] !== own[i]) return out;
          }
          at += own.length;
          hashed = nodeRlp(node.child, keccak).length >= 32;
          node = node.child;
          continue;
        }
        if (at === path.length) return out;             // the branch's own value slot
        const next = node.slots[path[at]];
        at++;
        if (next === null) return out;                  // an empty slot: absent, and provably so
        hashed = nodeRlp(next, keccak).length >= 32;
        node = next;
      }
    },
  };
}
