// The whole stack against a live node: a name in, an address out, and a proof in between.
//
// Everything else that touches Ethereum here is tested against recorded answers — this drives a real
// client over a real socket and lets it decide what comes back. What is being checked is the *composition*
// under conditions nobody chose: `packages/ens` computes the slot, `packages/ethrpc` asks for it,
// `packages/mpt` verifies the two tries, and anvil supplies the proof and the root.
//
// The slot is set through anvil's cheatcodes rather than by deploying a registry, and `cast` — a separate
// implementation — computes the namehash and mapping slot that the state is set at. So if `packages/ens`
// hashed the name left-to-right, or concatenated `slot ++ key` instead of `key ++ slot`, the program would
// ask about a slot nothing was written to and print "no owner": a wrong answer that looks like an answer,
// which is the reason this is worth running against a chain rather than a fixture.

import { appRunner } from "../../../harness/appRun.ts";
import { anvil, cast, HAVE_ANVIL, rpc } from "./anvil.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

const REGISTRY = "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e";
const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const RESOLVER = "0x4976fb03C32e5B8cfe2b6cCB31c09Ba78EBaBa41";

Deno.test({
  name: "ensowner: resolves a name against a live node, and proves it",
  ignore: !HAVE_ANVIL,
  sanitizeResources: false,
  fn: async () => {
    const node = await anvil();
    const run = await appRunner("packages/ethrpc/example/ensowner.wac", { net: true });
    try {
      // `cast` decides where the owner goes, so `packages/ens` has to agree with it to find anything.
      const slot = cast(["index", "bytes32", cast(["namehash", "wac.eth"]), "0"]);
      await rpc(node.port, "anvil_setStorageAt", [
        REGISTRY,
        slot,
        "0x" + OWNER.replace(/^0x/, "").toLowerCase().padStart(64, "0"),
      ]);
      await rpc(node.port, "evm_mine", []);

      // The resolver goes in the slot above the owner's, and both come back from **one** request now —
      // one account proof, one block. Asking twice would answer about two states, and a name transferred
      // between them would give an owner and a resolver that never coexisted.
      const resolverSlot = "0x" + (BigInt(slot) + 1n).toString(16).padStart(64, "0");
      await rpc(node.port, "anvil_setStorageAt", [
        REGISTRY,
        resolverSlot,
        "0x" + RESOLVER.replace(/^0x/, "").toLowerCase().padStart(64, "0"),
      ]);
      await rpc(node.port, "evm_mine", []);

      const r = await run.run(["wac.eth", "127.0.0.1", String(node.port)]);
      assertEquals(r.code, 0, `exit ${r.code}: ${r.err}`);
      assertEquals(r.out.split("\n")[0], OWNER.toLowerCase(), r.out);
      assertEquals(r.out.includes(`resolver ${RESOLVER.toLowerCase()}`), true, r.out);
      // The caveat is printed every run, because a proof against a root the same node supplied looks
      // exactly like one anchored to a verified header.
      assertEquals(r.err.includes("state root this node also supplied"), true, r.err);

      // **Anchored to a block hash.** The program re-encodes the header it was given and hashes it, so
      // this passing means our RLP of anvil's header — field order, minimal quantities, and which of the
      // six fork-appended fields are present — reproduces the hash anvil computed itself. A differential
      // against a real client, on the one value that ties a state root to a block.
      const block = await rpc(node.port, "eth_getBlockByNumber", ["latest", false]) as { hash: string };
      const anchored = await run.run(["wac.eth", "127.0.0.1", String(node.port), REGISTRY, block.hash]);
      assertEquals(anchored.code, 0, `exit ${anchored.code}: ${anchored.err}`);
      assertEquals(anchored.out.split("\n")[0], OWNER.toLowerCase(), anchored.out);
      assertEquals(anchored.err.includes("hashing to the block hash you gave"), true, anchored.err);

      // A hash from somewhere else has to be refused rather than ignored, or the argument is theatre — and
      // since an anchor *selects* the block, that refusal is now at the lookup rather than at a header
      // comparison. This case replaced one asserting the old message; keeping both would have been two
      // tests of one behaviour, one of them wrong.
      const unknown = await run.run(["wac.eth", "127.0.0.1", String(node.port), REGISTRY,
        "0x" + "de".repeat(32)]);
      assertEquals(unknown.code, 1, `an unknown block should fail, got ${unknown.code}`);
      assertEquals(unknown.err.includes("does not have the block"), true, unknown.err);

      // **A node that serves the latest state whatever block is asked for.** anvil does exactly this, so
      // this is not a hypothetical: mine a second block, anchor to the first, and the proof that comes
      // back is about the wrong one. Caught where it is legible — the account proof's root node hashes to
      // the state root by definition — rather than three layers down in the trie walk.
      // Sealed first, then captured: a cheatcode writes into the *pending* state, so a hash read before
      // one lands describes a block anvil then rebuilds — and the child gets "no such block", which is a
      // true answer to a question about a block that no longer exists. Mine, then capture, then write.
      await rpc(node.port, "evm_mine", []);
      const before = await rpc(node.port, "eth_getBlockByNumber", ["latest", false]) as { hash: string };
      await rpc(node.port, "anvil_setStorageAt", [REGISTRY, slot, "0x" + "00".repeat(30) + "beef"]);
      await rpc(node.port, "evm_mine", []);
      const stale = await run.run(["wac.eth", "127.0.0.1", String(node.port), REGISTRY, before.hash]);
      assertEquals(stale.code, 1, `a historical anchor should fail here, got ${stale.code}: ${stale.out}`);
      assertEquals(stale.err.includes("historical proofs"), true, stale.err);

      // A name nobody owns: absence is an answer, and the exit code says the question was answered.
      const none = await run.run(["nobody-owns-this.eth", "127.0.0.1", String(node.port)]);
      assertEquals(none.code, 0, `exit ${none.code}: ${none.err}`);
      assertEquals(none.out.trim(), "no owner", none.out);

      // And a node that is not there is a failure, not an empty answer.
      const closed = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const dead = (closed.addr as Deno.NetAddr).port;
      closed.close();
      const down = await run.run(["wac.eth", "127.0.0.1", String(dead)]);
      assertEquals(down.code, 1, `a refused connection should fail, got ${down.code}: ${down.out}`);
    } finally {
      await node.stop();
    }
  },
});
