// The two-step walk: a state trie to an account, then that account's storage trie to a slot.
//
// `proof_wac.test.ts` establishes the layer under this one — a TypeScript trie builder anchored to all seven
// of Ethereum's published roots, and a wac verifier that accepts its proofs and refuses every perturbation.
// This builds the *state* the way Ethereum does on top of that: a storage trie per account, an account RLP
// carrying its root, and a state trie of those accounts keyed by `keccak256(address)`.
//
// The composition is the thing being tested, and the failure it exists to prevent is subtle: two proofs that
// are each individually valid, against roots that have nothing to do with each other. So the storage root is
// never supplied by the test — it comes out of the account proof, exactly as a caller must take it.

import { wacBind } from "../../../harness/wacBind.ts";
import { trie } from "./trie.ts";
import { rlpEncode } from "./rlp.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

const probe = await wacBind("packages/mpt/test/wac/probe.wac") as Record<string, unknown>;
const keccak = probe.hash as (b: Uint8Array) => Uint8Array;
const accountRaw = probe.verifyAccount as (r: Uint8Array, a: Uint8Array, n: Uint8Array) => Uint8Array;
const storageRaw = probe.verifyStorage as (r: Uint8Array, s: Uint8Array, n: Uint8Array) => Uint8Array;

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const dec = new TextDecoder();

function packNodes(nodes: Uint8Array[]): Uint8Array {
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

type AccountAnswer = {
  ok: boolean;
  present: boolean;
  nonce: string;
  balance: string;
  storageRoot: Uint8Array;
  codeHash: string;
  error: string;
};

function accountAt(stateRoot: Uint8Array, address: Uint8Array, nodes: Uint8Array[]): AccountAnswer {
  const out = accountRaw(stateRoot, address, packNodes(nodes));
  const nl = out[2], bl = out[3];
  const present = out[1] === 1;
  const at = 4 + nl + bl;
  return {
    ok: out[0] === 1,
    present,
    nonce: hex(out.subarray(4, 4 + nl)),
    balance: hex(out.subarray(4 + nl, at)),
    storageRoot: present ? out.slice(at, at + 32) : new Uint8Array(0),
    codeHash: present ? hex(out.subarray(at + 32, at + 64)) : "",
    error: dec.decode(out.subarray(present ? at + 64 : at)),
  };
}

function storageAt(root: Uint8Array, slot: Uint8Array, nodes: Uint8Array[]) {
  const out = storageRaw(root, slot, packNodes(nodes));
  const len = out[2] | (out[3] << 8) | (out[4] << 16) | (out[5] << 24);
  return {
    ok: out[0] === 1,
    present: out[1] === 1,
    value: hex(out.subarray(6, 6 + len)),
    error: dec.decode(out.subarray(6 + len)),
  };
}

/** A 32-byte slot key, and the minimal big-endian bytes a slot value is stored as. */
const word = (n: number) => {
  const out = new Uint8Array(32);
  for (let i = 31, x = n; i >= 0 && x > 0; i--, x >>= 8) out[i] = x & 0xff;
  return out;
};
const minimal = (n: number) => {
  const out: number[] = [];
  for (let x = n; x > 0; x = Math.floor(x / 256)) out.unshift(x & 0xff);
  return new Uint8Array(out);
};

const emptyRoots = probe.emptyRoots as () => Uint8Array;

const EMPTY_STORAGE_ROOT = keccak(rlpEncode(new Uint8Array(0)));
const EMPTY_CODE_HASH = keccak(new Uint8Array(0));

/** An account's four fields, RLP-encoded the way the state trie stores them. */
const accountRlp = (nonce: number, balance: number, storageRoot: Uint8Array, codeHash: Uint8Array) =>
  rlpEncode([minimal(nonce), minimal(balance), storageRoot, codeHash]);

// ── A small world: three accounts, one of them a contract with storage ───────────

const address = (n: number) => {
  const out = new Uint8Array(20);
  out[19] = n;
  return out;
};

const slots: [number, number][] = [[0, 42], [1, 1_000_000], [7, 255], [1_000, 1]];
const storage = trie(
  slots.map(([k, v]) => [keccak(word(k)), rlpEncode(minimal(v))] as [Uint8Array, Uint8Array]),
  keccak,
);

const accounts: [Uint8Array, Uint8Array][] = [
  [keccak(address(1)), accountRlp(3, 5_000, EMPTY_STORAGE_ROOT, EMPTY_CODE_HASH)],
  [keccak(address(2)), accountRlp(0, 1, storage.root, keccak(new Uint8Array([0x60, 0x60])))],
  [keccak(address(3)), accountRlp(1, 0, EMPTY_STORAGE_ROOT, EMPTY_CODE_HASH)],
];
const state = trie(accounts, keccak);

Deno.test("the two empty constants are what they claim to be", () => {
  // `emptyStorageRoot()` and `emptyCodeHash()` are literals in wac's sense — functions returning a fixed
  // hash — and nothing called them, so mutation testing replaced each body with a constant and every test
  // still passed. The file *derives* both values here, for the accounts it builds, and then never compared
  // its derivation against the package's answer.
  //
  // What this anchors is the composition: the storage root of an account with no storage is the root of an
  // empty trie, `keccak256(rlp(""))`, and its code hash is `keccak256("")` — not `keccak256(rlp(""))` again,
  // which is the confusion the two being adjacent invites. keccak256 itself is anchored against `node:crypto`
  // in `packages/crypto`, so it is not being trusted here on its own say-so.
  const got = emptyRoots();
  assertEquals(hex(got.subarray(0, 32)), hex(EMPTY_STORAGE_ROOT), "emptyStorageRoot");
  assertEquals(hex(got.subarray(32, 64)), hex(EMPTY_CODE_HASH), "emptyCodeHash");
  assertEquals(hex(EMPTY_STORAGE_ROOT) === hex(EMPTY_CODE_HASH), false, "they are not the same hash");
});

Deno.test("an account is read out of the state trie, fields and all", () => {
  const got = accountAt(state.root, address(2), state.proof(keccak(address(2))));
  assertEquals(got.ok, true, got.error);
  assertEquals(got.present, true, "the account should be there");
  assertEquals(got.nonce, "", "a zero nonce is the empty string, not a zero byte");
  assertEquals(got.balance, "01");
  assertEquals(hex(got.storageRoot), hex(storage.root), "the storage root the account carries");
  assertEquals(got.codeHash, hex(keccak(new Uint8Array([0x60, 0x60]))));

  const eoa = accountAt(state.root, address(1), state.proof(keccak(address(1))));
  assertEquals(eoa.ok, true, eoa.error);
  assertEquals(eoa.nonce, "03");
  assertEquals(eoa.balance, "1388", "5000, big-endian and minimal");
  assertEquals(hex(eoa.storageRoot), hex(EMPTY_STORAGE_ROOT), "an account with no storage");
  assertEquals(eoa.codeHash, hex(EMPTY_CODE_HASH), "and no code");
});

Deno.test("an address the state has never seen is proved absent", () => {
  const missing = address(99);
  const got = accountAt(state.root, missing, state.proof(keccak(missing)));
  assertEquals(got.ok, true, `absence should verify — ${got.error}`);
  assertEquals(got.present, false, "there is no such account");
});

Deno.test("a slot is read out of the storage trie under the root the account gave", () => {
  // The composition: the root is taken from the account proof, never from the test's own variable. A caller
  // that supplies it from elsewhere can be handed a valid proof of a *different* account's storage.
  const acct = accountAt(state.root, address(2), state.proof(keccak(address(2))));
  assertEquals(acct.ok && acct.present, true, acct.error);

  for (const [slot, value] of slots) {
    const key = word(slot);
    const got = storageAt(acct.storageRoot, key, storage.proof(keccak(key)));
    assertEquals(got.ok, true, `slot ${slot}: ${got.error}`);
    assertEquals(got.present, true, `slot ${slot}: reported absent`);
    assertEquals(got.value, hex(minimal(value)), `slot ${slot}: wrong value`);
  }
});

Deno.test("a slot that was never written is absent, which is how zero is stored", () => {
  // Ethereum stores no zero slots: writing zero deletes the entry. So "absent" and "zero" are the same
  // state, and a verifier that reported a zero *value* would be inventing one — the caller has to see
  // `present = false` and decide what zero means in its own terms.
  const acct = accountAt(state.root, address(2), state.proof(keccak(address(2))));
  for (const slot of [2, 3, 999, 1_000_000]) {
    const key = word(slot);
    const got = storageAt(acct.storageRoot, key, storage.proof(keccak(key)));
    assertEquals(got.ok, true, `slot ${slot}: absence should verify — ${got.error}`);
    assertEquals(got.present, false, `slot ${slot}: reported present with ${got.value}`);
    assertEquals(got.value, "", `slot ${slot}: an absent slot has no value`);
  }
});

Deno.test("an account with no storage refuses a storage proof from another account", () => {
  // The failure the composition exists to prevent, made concrete: account 1 has the empty storage root, and
  // a provider hands over account 2's perfectly valid storage proof. Every node in it verifies against
  // account 2's root and none of them against this one.
  const eoa = accountAt(state.root, address(1), state.proof(keccak(address(1))));
  assertEquals(hex(eoa.storageRoot), hex(EMPTY_STORAGE_ROOT));
  const key = word(0);
  const got = storageAt(eoa.storageRoot, key, storage.proof(keccak(key)));
  assertEquals(got.ok, false, `a foreign storage proof was accepted: ${got.value}`);
});

Deno.test("the account's own bytes are checked, not just the path to them", () => {
  // An account that is not four items, or whose roots are the wrong length, has to fail as an *account*
  // rather than survive into a storage walk that then blames the proof. Built by putting a malformed
  // account into a trie of its own, since nothing else can produce one.
  const bad: [string, Uint8Array][] = [
    ["three items", rlpEncode([minimal(1), minimal(2), EMPTY_STORAGE_ROOT])],
    ["a byte string, not a list", rlpEncode(new Uint8Array([1, 2, 3]))],
    ["a 31-byte storage root", rlpEncode([
      minimal(1),
      minimal(2),
      EMPTY_STORAGE_ROOT.subarray(0, 31),
      EMPTY_CODE_HASH,
    ])],
    ["a 16-byte code hash", rlpEncode([
      minimal(1),
      minimal(2),
      EMPTY_STORAGE_ROOT,
      EMPTY_CODE_HASH.subarray(0, 16),
    ])],
  ];
  for (const [what, value] of bad) {
    const t = trie([[keccak(address(5)), value]], keccak);
    const got = accountAt(t.root, address(5), t.proof(keccak(address(5))));
    assertEquals(got.ok, false, `${what}: accepted`);
    assertEquals(got.error.length > 0, true, `${what}: refused without saying why`);
  }
});

Deno.test("a slot's stored value must be canonical RLP of at most 32 bytes", () => {
  // The trie stores `rlp(value)`, so a slot can carry things a slot cannot hold: a list, 33 bytes, or a
  // leading zero — which is a second encoding of a number the trie is supposed to have one encoding for.
  const key = word(0);
  const bad: [string, Uint8Array][] = [
    ["a list", rlpEncode([minimal(1)])],
    ["33 bytes", rlpEncode(new Uint8Array(33).fill(0xab))],
    ["a leading zero", rlpEncode(new Uint8Array([0x00, 0x01]))],
  ];
  for (const [what, value] of bad) {
    const t = trie([[keccak(key), value]], keccak);
    const got = storageAt(t.root, key, t.proof(keccak(key)));
    assertEquals(got.ok, false, `${what}: accepted as a slot value`);
  }
});

Deno.test("an address is twenty bytes and a slot key is thirty-two", () => {
  // The hashing happens inside, because a state trie is a secure trie by definition — so a caller handing
  // over an unhashed or mis-sized key would otherwise get a confident wrong answer instead of an error.
  //
  // The proof handed over here is **valid for the mis-sized key**, which is what makes this a test of the
  // length check rather than of the walk: a trie built over `keccak(19 bytes)` produces a proof that
  // verifies, so deleting the check turns this from a refusal into a wrong answer. Written the obvious way
  // first — a mis-sized key with somebody else's proof — it passed with the check deleted, because the walk
  // refused it for an unrelated reason.
  const shortAddr = new Uint8Array(19).fill(7);
  const t1 = trie([[keccak(shortAddr), accountRlp(1, 2, EMPTY_STORAGE_ROOT, EMPTY_CODE_HASH)]], keccak);
  const short = accountAt(t1.root, shortAddr, t1.proof(keccak(shortAddr)));
  assertEquals(short.ok, false, "a 19-byte address was accepted, with a proof that fits it");

  const shortSlot = new Uint8Array(31).fill(9);
  const t2 = trie([[keccak(shortSlot), rlpEncode(minimal(5))]], keccak);
  const long = storageAt(t2.root, shortSlot, t2.proof(keccak(shortSlot)));
  assertEquals(long.ok, false, "a 31-byte slot key was accepted, with a proof that fits it");
});
