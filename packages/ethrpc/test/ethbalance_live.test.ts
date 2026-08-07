// A balance proved against the state root, checked against the number the node would have told us.
//
// `eth_getBalance` is the answer a caller would otherwise believe, so it is the perfect oracle here: the
// proof has to arrive at exactly the number the node claims, having got there a different way — down the
// state trie and out of the account's four RLP items. A disagreement means one of them is wrong, and only
// one of them showed its working.
//
// This is also the only live exercise of the *account* fields. `packages/mpt` proves them against vendored
// fixtures and `ensowner` only ever reads a storage slot, so nonce and balance had never come off a real
// chain.

import { appRunner } from "../../../harness/appRun.ts";
import { anvil, HAVE_ANVIL, rpc } from "./anvil.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

Deno.test({
  name: "ethbalance: the proved balance is the one the node would have told us",
  ignore: !HAVE_ANVIL,
  sanitizeResources: false,
  fn: async () => {
    const node = await anvil();
    const run = await appRunner("packages/ethrpc/example/ethbalance.wac", { net: true });
    try {
      // Mine once first. At block zero anvil serves proofs against a state whose root is not the one block
      // zero declares, so the root check refuses — correctly, and it is the check earning its keep on the
      // first thing that ran into it. A real chain is never at genesis when someone asks it a question.
      await rpc(node.port, "evm_mine", []);

      // anvil's first prefunded account: 10000 ether, which is far past what an i64 holds — the decimal
      // conversion is long division over the bytes for exactly this reason.
      const funded = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
      const asked = await rpc(node.port, "eth_getBalance", [funded, "latest"]) as string;
      const want = BigInt(asked).toString();

      const got = await run.run([funded, "127.0.0.1", String(node.port)]);
      assertEquals(got.code, 0, `exit ${got.code}: ${got.err}`);
      assertEquals(got.out.split("\n")[0], `${want} wei`, got.out);
      assertEquals(got.out.includes("nonce 0"), true, got.out);

      // A balance set to something that is not round, so a conversion that dropped digits shows.
      const odd = "0x00000000000000000000000000000000000000aa";
      await rpc(node.port, "anvil_setBalance", [odd, "0x1234567890abcdef"]);
      await rpc(node.port, "evm_mine", []);
      const oddWant = BigInt("0x1234567890abcdef").toString();
      const oddGot = await run.run([odd, "127.0.0.1", String(node.port)]);
      assertEquals(oddGot.out.split("\n")[0], `${oddWant} wei`, oddGot.out);

      // An address nothing has ever touched is *absent* from the state trie, which is a proof that it
      // holds nothing — not the same as a zero that was written, and the output says which.
      const nobody = await run.run(["0x00000000000000000000000000000000deadbeef", "127.0.0.1",
        String(node.port)]);
      assertEquals(nobody.code, 0, `exit ${nobody.code}: ${nobody.err}`);
      assertEquals(nobody.out.includes("not in the state trie"), true, nobody.out);

      // And the caveat is printed every run, as `ensowner` does.
      assertEquals(got.err.includes("state root this node also supplied"), true, got.err);
    } finally {
      await node.stop();
    }
  },
});
