// Generates `test/vendor/registry.json`: an ENS registry's storage, proved by a real client.
//
//     ~/tools/foundry/anvil --port 8546 --silent &
//     deno run -A packages/ens/tools/vendor-registry.ts > packages/ens/test/vendor/registry.json
//
// **Run by hand, not by the suite** — the output is committed, so the tests need no client and cannot
// silently start passing because nothing was listening.
//
// ## What this is for
//
// `test/registry_wac.test.ts` is the first test in this repo that composes several packages instead of
// checking one against an oracle: a name goes in and an address comes out, through `namehash`, Solidity's
// mapping layout, a state-trie proof and a storage-trie proof, with every step in wac. A fixture for that
// has to come from somewhere none of those steps came from.
//
// So the state is built with **anvil**'s cheatcodes and the two derivations are cross-checked against
// **cast**, which is a separate implementation of both:
//
//   - `cast namehash wac.eth`                    against `ens.namehash`
//   - `cast index bytes32 <node> 0`              against `registry.ownerSlot`
//
// Those two are the ones a composition gets wrong silently: a node computed left-to-right instead of
// right-to-left, or a mapping slot hashed as `slot ++ key` instead of `key ++ slot`, both produce a
// perfectly valid proof about the wrong storage slot, and the answer is "this name has no owner".
//
// The registry address is the real mainnet one, and the owner is a well-known address — neither matters to
// what is being tested, but a fixture full of `0x1111…` invites the reader to assume the shapes are made
// up too.

const RPC = "http://127.0.0.1:8546";
const CAST = `${Deno.env.get("HOME") ?? "/home/claude"}/tools/foundry/cast`;

/** The ENS registry, at the address it has had since 2017. */
const REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";
const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const RESOLVER = "0x4976fb03C32e5B8cfe2b6cCB31c09Ba78EBaBa41";

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

function cast(args: string[]): string {
  const r = new Deno.Command(CAST, { args, stdout: "piped", stderr: "piped" }).outputSync();
  if (r.code !== 0) throw new Error(`cast ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
  return new TextDecoder().decode(r.stdout).trim();
}

/** `n + 1` over a 32-byte big-endian word — the struct's next field, carried the long way. */
function plusOne(hex: string): string {
  const b = Uint8Array.from(hex.slice(2).match(/../g)!.map((h) => parseInt(h, 16)));
  for (let i = 31; i >= 0; i--) {
    if (b[i] === 255) b[i] = 0;
    else {
      b[i] += 1;
      break;
    }
  }
  return "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const word = (addr: string) => "0x" + addr.replace(/^0x/, "").toLowerCase().padStart(64, "0");

type Case = { name: string; node: string; ownerSlot: string; resolverSlot: string; owned: boolean };

const names = ["wac.eth", "sub.wac.eth", "nobody-owns-this.eth"];
const cases: Case[] = names.map((name) => {
  const node = cast(["namehash", name]);
  const ownerSlot = cast(["index", "bytes32", node, "0"]);
  return { name, node, ownerSlot, resolverSlot: plusOne(ownerSlot), owned: name !== names[2] };
});

for (const c of cases) {
  if (!c.owned) continue;
  await rpc("anvil_setStorageAt", [REGISTRY, c.ownerSlot, word(OWNER)]);
  await rpc("anvil_setStorageAt", [REGISTRY, c.resolverSlot, word(RESOLVER)]);
}
await rpc("evm_mine");

const block = await rpc("eth_getBlockByNumber", ["latest", false]) as { stateRoot: string };

type Proof = {
  accountProof: string[];
  storageHash: string;
  storageProof: { key: string; value: string; proof: string[] }[];
};

const slots = cases.flatMap((c) => [c.ownerSlot, c.resolverSlot]);
const proof = await rpc("eth_getProof", [REGISTRY, slots, "latest"]) as Proof;

console.log(JSON.stringify({
  client: await rpc("web3_clientVersion"),
  generatedBy: "packages/ens/tools/vendor-registry.ts",
  note: "node and ownerSlot come from `cast`, not from this repo",
  registry: REGISTRY,
  owner: OWNER,
  resolver: RESOLVER,
  stateRoot: block.stateRoot,
  storageHash: proof.storageHash,
  accountProof: proof.accountProof,
  cases: cases.map((c) => ({
    ...c,
    ownerProof: proof.storageProof.find((s) => s.key === c.ownerSlot)!,
    resolverProof: proof.storageProof.find((s) => s.key === c.resolverSlot)!,
  })),
}, null, 2));
