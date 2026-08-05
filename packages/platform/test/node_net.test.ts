// Imported for its side effect: retries a spawn that fails with "Text file busy" and names
// whoever held the file, if anyone did. wac-mono 0074.
import "../../../harness/spawnRetry.ts";
import { freePort } from "../../../harness/port.ts";
// The Node host's sockets, against the Deno host's, with a real client attached.
//
// **This path had no test.** `platform.test.ts` builds the same program for both runtimes and compares
// them, which is the right shape — but the program it uses is `wc`, so it covers the filesystem and
// stdio and nothing else. `NODE_NET` in `build.ts` is a shim generated into every networked Node build,
// and it has been edited for `listen`'s address and for `accept`'s peer without anything but a manual
// check ever connecting to it.
//
// `example/greet.wac` is the shortest program that uses all three of the address, the peer and `send`.
// Built for both targets and driven by Deno's own client: what the two runtimes say has to match, and
// the address has to reach the kernel, which `ss` alone cannot tell you about a program that also has
// to answer.

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

const haveNode = await (async () => {
  try {
    return (await new Deno.Command("node", { args: ["--version"], stdout: "null" }).output()).success;
  } catch {
    return false;
  }
})();

/**
 * Start a built server, wait for it to say it is listening, connect, and read what it sends.
 *
 * Waiting for the line rather than for a timeout is the difference between a test and a coin flip: a
 * server mid-bind is a server a client cannot reach, and `greet.wac` prints that line for this reason.
 */
async function greeted(
  cmd: string,
  args: string[],
): Promise<{ said: string; logged: string; code: number }> {
  const child = new Deno.Command(cmd, { args, stdout: "piped", stderr: "piped" }).spawn();
  const out: string[] = [];
  const reader = (async () => {
    const dec = new TextDecoder();
    for await (const chunk of child.stdout) out.push(dec.decode(chunk));
  })();

  try {
    // The port comes out of the line, because the server was started on port 0: the kernel chose, and
    // `Socket.port` is how a program can say what it chose. Two hardcoded ports here used to collide
    // with anything else on this shared machine, and one of them did.
    const deadline = Date.now() + 30_000;
    let port = 0;
    while (port === 0 && Date.now() < deadline) {
      const m = out.join("").match(/listening on (\d+)/);
      if (m !== null) port = Number(m[1]);
      else await new Promise((res) => setTimeout(res, 50));
    }
    if (port === 0) throw new Error(`the server never said its port: ${out.join("")}`);
    const conn = await Deno.connect({ hostname: "127.0.0.1", port });
    const buf = new Uint8Array(256);
    const n = await conn.read(buf);
    conn.close();
    const said = new TextDecoder().decode(buf.subarray(0, n ?? 0));
    const status = await child.status;
    await reader;
    return { said, logged: out.join(""), code: status.code };
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited, which is the ordinary case: `greet` serves one connection and stops.
    }
    await child.stderr.cancel().catch(() => {});
  }
}

Deno.test({
  name: "a wac server on Node says the same as one on Deno, to a real client",
  ignore: !haveNode,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { buildApp } = await import("../build.ts");
    const denoOut = await Deno.makeTempFile({ prefix: "wac-greet-deno-" });
    const nodeOut = await Deno.makeTempFile({ prefix: "wac-greet-node-" });
    try {
      await buildApp("packages/platform/example/greet.wac", denoOut, { net: true }, "deno");
      await buildApp("packages/platform/example/greet.wac", nodeOut, { net: true }, "node");

      // Loopback, so the peer is knowable: whatever address the client comes from is the one the
      // server must report, and on loopback that is `127.0.0.1` on both runtimes.
      const onDeno = await greeted(denoOut, ["127.0.0.1", "0"]);
      const onNode = await greeted("node", [nodeOut, "127.0.0.1", "0"]);

      assertEquals(onDeno.said, "hello 127.0.0.1\n", `deno: ${onDeno.logged}`);
      assertEquals(onNode.said, onDeno.said, `node said something else: ${onNode.logged}`);
      assertEquals(onNode.code, 0, onNode.logged);
      assertEquals(onDeno.code, 0, onDeno.logged);

      // And the program's own view of it, which is what `Socket.fromLoopback` is for.
      assertEquals(onDeno.logged.includes("peer 127.0.0.1 (loopback)"), true, onDeno.logged);
      assertEquals(onNode.logged.includes("peer 127.0.0.1 (loopback)"), true, onNode.logged);
    } finally {
      await Deno.remove(denoOut).catch(() => {});
      await Deno.remove(nodeOut).catch(() => {});
    }
  },
});

Deno.test({
  name: "...and a loopback bind on Node is a loopback bind, not every interface",
  ignore: !haveNode,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // The address has to reach the kernel, and the only witness is the socket table: a server that
    // answers on `127.0.0.1` answers there whether it bound loopback or the world. `ss` is asked rather
    // than a second interface, because a container may have only one and the bind is the claim.
    const { buildApp } = await import("../build.ts");
    const nodeOut = await Deno.makeTempFile({ prefix: "wac-greet-bind-" });
    try {
      await buildApp("packages/platform/example/greet.wac", nodeOut, { net: true }, "node");
      // A port from the kernel rather than a literal: bound, read, released, then handed over. The
      // window between releasing and binding is a race, and it is a smaller one than sharing a fixed
      // number with every other suite on this machine.
      // `freePort` rather than probe-and-close here: the port is handed to a *child*, so the window
      // between the close and its bind is the race in wac-mono 0069.
      const port = freePort();
      const child = new Deno.Command("node", {
        args: [nodeOut, "127.0.0.1", String(port)],
        stdout: "piped",
        stderr: "null",
      }).spawn();
      try {
        const dec = new TextDecoder();
        const seen: string[] = [];
        const reader = (async () => {
          for await (const c of child.stdout) seen.push(dec.decode(c));
        })();
        const deadline = Date.now() + 30_000;
        while (!seen.join("").includes("listening") && Date.now() < deadline) {
          await new Promise((res) => setTimeout(res, 50));
        }

        const ss = new Deno.Command("ss", { args: ["-ltn"], stdout: "piped", stderr: "null" })
          .outputSync();
        const table = new TextDecoder().decode(ss.stdout);
        const line = table.split("\n").find((l) => l.includes(String(port))) ?? "";
        assertEquals(
          line.includes(`127.0.0.1:${port}`),
          true,
          `bound elsewhere: ${line || table}`,
        );

        // Tidy: the server is waiting for a connection nobody is going to make.
        child.kill("SIGKILL");
        await child.status;
        await reader.catch(() => {});
      } catch (e) {
        try {
          child.kill("SIGKILL");
        } catch { /* gone */ }
        throw e;
      }
    } finally {
      await Deno.remove(nodeOut).catch(() => {});
    }
  },
});
