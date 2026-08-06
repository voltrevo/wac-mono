// A list where the format requires a byte string, in every position where one can appear.
//
// Upstream #43. `rlp.bytesOf` used to answer the empty string for `Item.List(...)`, and seven call sites in
// this package took it at its word. The empty string is not a rare value in a trie — it is what an absent
// branch child, an absent key and a zero-valued account field all look like — so a shape error did not
// become an error, it became one of those. Each case below is a node or an account that a lying provider
// could commit and hand over, and each used to verify:
//
//   leaf value is a list      → present, with an empty value: an answer to a question the trie never answered
//   branch terminal is a list → absent: a proof that a key is not there, built from a node that says nothing
//   account nonce is a list   → zero: an account that has never sent a transaction
//   account balance is a list → zero: an account holding nothing
//
// The nodes are built here rather than vendored because no published fixture contains them — `ethereum/tests`
// is a corpus of *valid* tries. They are constructed from this directory's own oracle so that the only thing
// wrong with each one is the single field under test: every case asserts its well-formed twin verifies first,
// which is what says the refusal is about the shape and not about the fixture being broken some other way.

import { hp, nibbles } from "./trie.ts";
import { rlpEncode, type RlpItem } from "./rlp.ts";
import { accountAt, hex, keccak, storageAt, verify } from "./probe.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

const key = Uint8Array.from([0xab, 0xcd]);
const empty = new Uint8Array(0);

/** A one-node trie: the root is a leaf holding the whole key. */
const leafNode = (value: RlpItem) => rlpEncode([hp(nibbles(key), true), value]);

/** A seventeen-item branch reached by the whole key, so the walk lands on its own value slot. */
function branchTrie(terminal: RlpItem): { root: Uint8Array; nodes: Uint8Array[] } {
  // Two branches consume the key's four nibbles two at a time is not how a trie works — a branch consumes
  // one nibble each — so four of them are needed to arrive at the fifth with the key exhausted.
  const slot = (child: RlpItem, at: number): RlpItem[] => {
    const items: RlpItem[] = Array.from({ length: 17 }, () => empty as RlpItem);
    items[at] = child;
    return items;
  };
  const last = rlpEncode(slot(empty, 0).map((x, i) => (i === 16 ? terminal : x)));
  const nibs = nibbles(key);
  const built: Uint8Array[] = [last];
  let ref: RlpItem = keccak(last);
  for (let i = nibs.length - 1; i >= 0; i--) {
    const node = rlpEncode(slot(ref, nibs[i]));
    built.unshift(node);
    ref = keccak(node);
  }
  return { root: ref as Uint8Array, nodes: built };
}

Deno.test("a leaf whose value is a list is refused, not read as an empty value", () => {
  const good = leafNode(Uint8Array.from([1, 2, 3]));
  const wellFormed = verify(keccak(good), key, [good]);
  assertEquals(wellFormed.ok, true, `the well-formed twin should verify — ${wellFormed.error}`);
  assertEquals(wellFormed.present, true);

  const bad = leafNode([]);
  const got = verify(keccak(bad), key, [bad]);
  assertEquals(got.ok, false, `accepted, present=${got.present} with value ${got.value}`);
  assertEquals(got.error.includes("leaf"), true, `the message does not say where: ${got.error}`);
});

Deno.test("a branch terminal that is a list is refused, not read as absence", () => {
  const good = branchTrie(Uint8Array.from([7]));
  const wellFormed = verify(good.root, key, good.nodes);
  assertEquals(wellFormed.ok, true, `the well-formed twin should verify — ${wellFormed.error}`);
  assertEquals(wellFormed.present, true, "the branch holds a value at the key");

  const bad = branchTrie([]);
  const got = verify(bad.root, key, bad.nodes);
  assertEquals(got.ok, false, `accepted, present=${got.present}`);
  assertEquals(got.error.includes("branch"), true, `the message does not say where: ${got.error}`);
});

Deno.test("a hex-prefix header that is a list is refused", () => {
  // This one was already rejected, but for the wrong reason — `bytesOf` answered empty and the walk
  // complained that the header was missing. A message that sends the reader looking for a truncated node
  // when the node is the wrong *shape* costs an hour.
  const bad = rlpEncode([[], Uint8Array.from([1])]);
  const got = verify(keccak(bad), key, [bad]);
  assertEquals(got.ok, false, "accepted");
  assertEquals(got.error.includes("list"), true, `the message does not say what was wrong: ${got.error}`);
});

// ── Accounts ────────────────────────────────────────────────────────────────────

const address = new Uint8Array(20);
address[19] = 9;

/** An account whose `at`th field is a list instead of a byte string; -1 for the well-formed one. */
function accountTrie(at: number): { root: Uint8Array; nodes: Uint8Array[] } {
  const fields: RlpItem[] = [
    Uint8Array.from([3]), // nonce
    Uint8Array.from([0x10]), // balance
    keccak(rlpEncode(empty)), // storage root of an account with no storage
    keccak(empty), // code hash of an account that is not a contract
  ];
  if (at >= 0) fields[at] = [];
  const value = rlpEncode(fields);
  const path = nibbles(keccak(address));
  const node = rlpEncode([hp(path, true), value]);
  return { root: keccak(node), nodes: [node] };
}

Deno.test("an account field that is a list is refused, in every one of the four", () => {
  const good = accountTrie(-1);
  const wellFormed = accountAt(good.root, address, good.nodes);
  assertEquals(wellFormed.ok, true, `the well-formed account should verify — ${wellFormed.error}`);
  assertEquals(wellFormed.present, true);

  for (const [at, name] of [[0, "nonce"], [1, "balance"], [2, "storage root"], [3, "code hash"]] as const) {
    const bad = accountTrie(at);
    const got = accountAt(bad.root, address, bad.nodes);
    assertEquals(got.ok, false, `${name}: accepted`);
    assertEquals(got.error.includes(name), true, `${name}: the message names the wrong field — ${got.error}`);
  }
});

// ── The empty trie ──────────────────────────────────────────────────────────────

Deno.test("absence from an empty trie is proved by no nodes at all", () => {
  // Upstream #44. `verify` refused every zero-node proof before it looked at the root, and the empty trie
  // is the one case where there is nothing to walk: the root *is* the statement that the trie is empty.
  // This is not a corner case — it is what a storage proof for an account that has never written a slot
  // looks like, so a light client asking about one got "a proof with no nodes proves nothing" for an
  // answer that was in front of it.
  const root = keccak(rlpEncode(empty));
  for (const k of ["", "a key", "0x00", "0x" + "ff".repeat(32)]) {
    const key = k.startsWith("0x")
      ? Uint8Array.from(k.slice(2).match(/../g)!.map((h) => parseInt(h, 16)))
      : new TextEncoder().encode(k);
    const got = verify(root, key, []);
    assertEquals(got.ok, true, `${k || "(empty key)"}: ${got.error}`);
    assertEquals(got.present, false, `${k}: nothing is present in an empty trie`);
  }
});

Deno.test("no nodes against any other root still proves nothing", () => {
  // The half that makes the above safe. If a zero-node proof were accepted against an arbitrary root, a
  // provider could answer *every* question with "absent" by sending nothing.
  const populated = leafNode(Uint8Array.from([1]));
  for (const [what, root] of [
    ["a populated trie's root", keccak(populated)],
    ["all zeroes", new Uint8Array(32)],
    ["the empty trie root with one byte changed", (() => {
      const r = keccak(rlpEncode(empty));
      r[31] ^= 1;
      return r;
    })()],
  ] as const) {
    const got = verify(root, key, []);
    assertEquals(got.ok, false, `${what}: accepted an empty proof`);
  }
});

Deno.test("a slot of an account with no storage is absent, not unprovable", () => {
  // The composition #44 is actually about: the storage root comes out of the account, and for an account
  // that has never written a slot it is the empty trie's.
  const good = accountTrie(-1);
  const acct = accountAt(good.root, address, good.nodes);
  assertEquals(acct.ok, true, acct.error);
  assertEquals(hex(acct.storageRoot), hex(keccak(rlpEncode(empty))), "this account has no storage");

  const slot = new Uint8Array(32);
  slot[31] = 7;
  const got = storageAt(acct.storageRoot, slot, []);
  assertEquals(got.ok, true, `the empty storage should answer — ${got.error}`);
  assertEquals(got.present, false, "the slot is unset");
  assertEquals(got.value, "", "and has no value");
});
