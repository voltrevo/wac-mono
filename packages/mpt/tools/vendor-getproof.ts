// Generates `test/vendor/getproof.json` from a real Ethereum client's `eth_getProof`.
//
//     anvil --port 8545 --silent &
//     deno run -A packages/mpt/tools/vendor-getproof.ts > packages/mpt/test/vendor/getproof.json
//
// **Run by hand, not by the suite** — the same rule as every other vendored corpus here: the output is
// committed, a few kilobytes, so the tests need no network and cannot silently start passing because
// nothing was listening on 8545.
//
// ## Why a client, when `test/trie.ts` already builds tries
//
// Because they can be wrong together. The TypeScript builder and the wac verifier were written by the same
// hand on the same afternoon from the same reading of the same specification, and `trieanyorder.json`
// anchors the *roots* they produce — not the shape of a proof, not what a client actually sends, and not
// the composition of an account proof with a storage proof. A published root cannot tell you that a real
// client answers `["0x80"]` where this repo's builder answers `[]`; only a real client can, and it did,
// which is how wac-mono upstream #44 grew a second case (see `src/proof.wac`).
//
// So this is a differential test against an independent implementation: anvil's tries are Rust, from
// `alloy-trie`, and nothing about them came from here.
//
// ## Reproducing it
//
// The state is built by the script rather than assumed, so the fixture regenerates from a fresh anvil:
// three storage slots set on one address, a balance, and two accounts left alone. `anvil_setStorageAt` is
// used instead of deploying a contract so that no Solidity compiler is needed — what is being tested is the
// trie, and a slot set by a cheatcode sits in the same trie as a slot set by `SSTORE`.
//
// - **client:** anvil (Foundry), version recorded in the output as `client`
// - **rpc:** `http://127.0.0.1:8545`, no proxy — this is localhost
//
// If the numbers ever disagree with a re-run, the fixture is what is committed and the client is what
// moved: check `client` before assuming this package regressed.

const RPC = "http://127.0.0.1:8545";

let id = 0;
async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const body = await res.json() as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** A 32-byte hex word, which is what `eth_getProof` wants for a slot key. */
const word = (n: number) => "0x" + n.toString(16).padStart(64, "0");

const CONTRACT = "0x00000000000000000000000000000000000000aa";
const UNTOUCHED = "0x00000000000000000000000000000000000000bb";
/** anvil's first prefunded account: a real balance, a real place in the state trie, and no storage. */
const EOA = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

const SLOTS: [number, string][] = [
  [0, word(42)],
  [1, word(1_000_000)],
  [7, word(255)],
];

for (const [slot, value] of SLOTS) {
  await rpc("anvil_setStorageAt", [CONTRACT, word(slot), value]);
}
await rpc("anvil_setBalance", [CONTRACT, "0x1bc16d674ec80000"]);
await rpc("evm_mine");

const block = await rpc("eth_getBlockByNumber", ["latest", false]) as { stateRoot: string; number: string };

type Proof = {
  address: string;
  nonce: string;
  balance: string;
  storageHash: string;
  codeHash: string;
  accountProof: string[];
  storageProof: { key: string; value: string; proof: string[] }[];
};

async function proofOf(address: string, slots: number[], note: string) {
  const p = await rpc("eth_getProof", [address, slots.map(word), "latest"]) as Proof;
  return { note, ...p };
}

const out = {
  client: await rpc("web3_clientVersion"),
  generatedBy: "packages/mpt/tools/vendor-getproof.ts",
  stateRoot: block.stateRoot,
  blockNumber: block.number,
  cases: [
    // Slot 9 is asked for and never set: an absence proof inside a storage trie that has other things in it,
    // which is the case a verifier gets wrong by answering "not found" for anything it cannot walk.
    await proofOf(CONTRACT, [0, 1, 7, 9], "an account with storage: three slots set, one never written"),
    // An address nothing has ever touched: absence from the *state* trie, and an empty storage root.
    await proofOf(UNTOUCHED, [0], "an account that does not exist"),
    // Present in the state trie, with nothing in its storage: the composition #44 is about.
    await proofOf(EOA, [0, 3], "a funded account that has never written a storage slot"),
  ],
};

console.log(JSON.stringify(out, null, 2));
