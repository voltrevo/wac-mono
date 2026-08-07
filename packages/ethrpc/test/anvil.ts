// A local Ethereum node for the tests that need one, and one place that knows where it lives.
//
// `anvil` is a whole execution client: it parses JSON-RPC, keeps a real state trie, and answers the shapes
// a public endpoint answers. Everything else here is tested against recorded answers; these tests send a
// request over a socket and let a node decide what comes back.
//
// **The skip says why, on stderr.** A skip that prints nothing reads as coverage — the failure
// `packages/tls/test/openssl35.ts` exists to stop, after two ML-KEM interop tests spent their whole lives
// "2 ignored". `~/tools/foundry` rather than `/tmp` for the same reason: /tmp does not survive a restart,
// and a reference that vanishes is one the tests quietly stop using.

export const ANVIL = Deno.env.get("ANVIL") ?? `${Deno.env.get("HOME") ?? "/home/claude"}/tools/foundry/anvil`;
export const HAVE_ANVIL = (() => {
  try {
    return Deno.statSync(ANVIL).isFile;
  } catch {
    return false;
  }
})();
if (!HAVE_ANVIL) {
  console.error(
    `\n  anvil not found at ${ANVIL} — packages/ethrpc's live test will not run.\n` +
      `  Install it with the release tarball for this machine's architecture (aarch64):\n` +
      `    https://github.com/foundry-rs/foundry/releases  →  ~/tools/foundry/anvil\n`,
  );
}

/** A node on a free port, and a promise that resolves when it is answering. */
export async function anvil(): Promise<{ port: number; stop: () => Promise<void> }> {
  const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  const proc = new Deno.Command(ANVIL, {
    args: ["--port", String(port), "--silent"],
    stdout: "null",
    stderr: "null",
  }).spawn();
  // Wait for it to answer rather than sleeping a fixed time: a fixed sleep is either flaky or slow, and
  // on a shared machine it is both.
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      await r.text();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return {
    port,
    stop: async () => {
      try {
        proc.kill();
      } catch { /* already gone */ }
      await proc.status;
    },
  };
}


/** One JSON-RPC call, from the test side — for setting up state, not for testing the client. */
export async function rpc(port: number, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json() as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** `cast`, which computes namehashes and mapping slots independently of `packages/ens`. */
export function cast(args: string[]): string {
  const bin = `${Deno.env.get("HOME") ?? "/home/claude"}/tools/foundry/cast`;
  const r = new Deno.Command(bin, { args, stdout: "piped", stderr: "piped" }).outputSync();
  if (r.code !== 0) throw new Error(`cast ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
  return new TextDecoder().decode(r.stdout).trim();
}
