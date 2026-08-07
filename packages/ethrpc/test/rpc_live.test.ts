// The RPC client against a real node.
//
// `anvil` is a whole Ethereum execution client — it parses the JSON-RPC, keeps a real state trie, and
// answers the same shapes a public endpoint does. Everything else in this repo that touches Ethereum is
// tested against *recorded* answers; this is the one place the request goes out over a socket and a node
// on the other end decides what comes back.
//
// It is skipped when anvil is absent, and **says so on stderr with the path it looked in** — a skip that
// prints nothing reads as coverage, which is the failure `packages/tls/test/openssl35.ts` was written to
// stop. `~/tools/foundry` rather than `/tmp` for the same reason: /tmp does not survive a restart.

import { appRunner } from "../../../harness/appRun.ts";
import { anvil, HAVE_ANVIL } from "./anvil.ts";

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
  name: "ethrpc: asks a real node for its block number, over a real socket",
  ignore: !HAVE_ANVIL,
  sanitizeResources: false,
  fn: async () => {
    const node = await anvil();
    const run = await appRunner("packages/ethrpc/example/blocknumber.wac", { net: true });
    try {
      const r = await run.run(["127.0.0.1", String(node.port)]);
      assertEquals(r.code, 0, `exit ${r.code}: ${r.err}`);
      // anvil starts at block zero and mines on demand, so the answer is `0x0` — checked exactly, because
      // "some hex string" would pass for an error message that happened to start with 0x.
      assertEquals(r.out.trim(), "0x0", r.out);

      // And with nothing listening on that port, it must say so rather than printing an empty answer.
      const closed = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const dead = (closed.addr as Deno.NetAddr).port;
      closed.close();
      const bad = await run.run(["127.0.0.1", String(dead)]);
      assertEquals(bad.code, 1, `a refused connection should fail, got ${bad.code}: ${bad.out}`);
      assertEquals(bad.err.includes("blocknumber:"), true, bad.err);
    } finally {
      await node.stop();
    }
  },
});
