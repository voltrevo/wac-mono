// Proofs from a real Ethereum client, verified by `packages/mpt`.
//
// Issue 0086 asked for this and it was the last thing open in that issue: everything else in this package is
// tested against `test/trie.ts`, a TypeScript trie written here. That builder is anchored to seven published
// roots, which is a strong check on the *encoding* — and no check at all on what a client actually sends, or
// on whether the two halves of a composed proof fit together the way a provider assembles them.
//
// `test/vendor/getproof.json` is `eth_getProof` from anvil, whose tries are `alloy-trie` in Rust and share
// nothing with this repo. Regenerate with `tools/vendor-getproof.ts`; the file is committed so the suite
// needs no client.
//
// **It found something immediately.** For an account that has never written a storage slot, anvil answers a
// storage proof of `["0x80"]` — one node, the RLP of the empty string, which is what the empty trie root is
// the hash of. This repo's own builder produces `[]` for the same situation, so upstream #44 was implemented
// for zero nodes and refused the real client's answer with "a node must be a list, and this one is a byte
// string". Two implementations agreeing about a root can still disagree about how to say "nothing".

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

const unhex = (s: string) => Uint8Array.from(s.replace(/^0x/, "").match(/../g)?.map((h) => parseInt(h, 16)) ?? []);

type Case = {
  note: string;
  address: string;
  nonce: string;
  balance: string;
  storageHash: string;
  codeHash: string;
  accountProof: string[];
  storageProof: { key: string; value: string; proof: string[] }[];
};

const vector = JSON.parse(
  await Deno.readTextFile(new URL("./vendor/getproof.json", import.meta.url)),
) as { client: string; stateRoot: string; cases: Case[] };

if (vector.cases.length < 3) {
  throw new Error(`only ${vector.cases.length} cases — is the vendored file intact?`);
}

const stateRoot = unhex(vector.stateRoot);
const byNote = (s: string) => {
  const c = vector.cases.find((x) => x.note.includes(s));
  if (c === undefined) throw new Error(`no case matching "${s}" — the fixture has changed shape`);
  return c;
};

/** `eth_getProof` gives quantities minimally hex-encoded; the trie stores the same minimal bytes. */
const quantity = (s: string) => {
  const t = s.replace(/^0x/, "").replace(/^0+/, "");
  return t.length === 0 ? "" : (t.length % 2 === 1 ? "0" + t : t);
};

Deno.test("an account with storage verifies against a real client's state root", () => {
  const c = byNote("an account with storage");
  const got = accountAt(stateRoot, unhex(c.address), c.accountProof.map(unhex));
  assertEquals(got.ok, true, got.error);
  assertEquals(got.present, true, "the account is in the state trie");
  assertEquals(got.nonce, quantity(c.nonce), "nonce");
  assertEquals(got.balance, quantity(c.balance), "balance");
  // The storage root is taken from the proof rather than from the fixture — that is the composition — but it
  // has to be the one the client reported, or the two halves are about different accounts.
  assertEquals(hex(got.storageRoot), c.storageHash.slice(2), "storage root");
  assertEquals(got.codeHash, c.codeHash.slice(2), "code hash");

  for (const s of c.storageProof) {
    const slot = storageAt(got.storageRoot, unhex(s.key), s.proof.map(unhex));
    assertEquals(slot.ok, true, `slot ${s.key}: ${slot.error}`);
    const want = quantity(s.value);
    assertEquals(slot.present, want !== "", `slot ${s.key}: presence`);
    assertEquals(slot.value, want, `slot ${s.key}: value`);
  }
});

Deno.test("an account that does not exist is proved absent", () => {
  const c = byNote("does not exist");
  const got = accountAt(stateRoot, unhex(c.address), c.accountProof.map(unhex));
  assertEquals(got.ok, true, got.error);
  assertEquals(got.present, false, "nothing has ever touched this address");
});

Deno.test("a funded account with no storage answers absent for every slot", () => {
  // The case that found the `["0x80"]` spelling. The client sends one node where this repo's builder sends
  // none, and both mean the same empty trie.
  const c = byNote("never written a storage slot");
  const got = accountAt(stateRoot, unhex(c.address), c.accountProof.map(unhex));
  assertEquals(got.ok, true, got.error);
  assertEquals(got.present, true, "the account is funded, so it is in the state trie");
  assertEquals(got.balance, quantity(c.balance), "balance");
  assertEquals(hex(got.storageRoot), c.storageHash.slice(2), "storage root");

  for (const s of c.storageProof) {
    assertEquals(s.proof.length, 1, `the client sends one node for an empty storage trie, not ${s.proof.length}`);
    assertEquals(s.proof[0], "0x80", "and that node is the RLP of the empty string");
    const slot = storageAt(got.storageRoot, unhex(s.key), s.proof.map(unhex));
    assertEquals(slot.ok, true, `slot ${s.key}: ${slot.error}`);
    assertEquals(slot.present, false, `slot ${s.key}: nothing was ever written`);
  }
});

Deno.test("the client's roots are this package's constants", () => {
  // `emptyStorageRoot()` was checked against a derivation of its own in `account_wac.test.ts`. Here it is
  // checked against what a third-party client reports for an account with no storage — and the code hash
  // against what it reports for an account with no code.
  const c = byNote("never written a storage slot");
  assertEquals(c.storageHash, "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421");
  assertEquals(c.codeHash, "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assertEquals(hex(keccak(Uint8Array.from([0x80]))), c.storageHash.slice(2), "keccak256(rlp(\"\"))");
  assertEquals(hex(keccak(new Uint8Array(0))), c.codeHash.slice(2), "keccak256(\"\")");
});

Deno.test("a proof from one account does not verify against another", () => {
  // Two valid proofs against one root, swapped. The state root is the same for both, so nothing about the
  // bytes is wrong — only which key they are a path for.
  const a = byNote("an account with storage");
  const b = byNote("never written a storage slot");
  const got = accountAt(stateRoot, unhex(a.address), b.accountProof.map(unhex));
  assertEquals(got.ok && got.present, false, "somebody else's proof answered for this address");
});
