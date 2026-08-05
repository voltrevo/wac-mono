// Composing children: a pipeline, and a child serving a socket.
//
// `spawn.test.ts` covers one child in isolation. What these two cover is the claim that
// handles compose — that standard input, a socket and a child are interchangeable to `recv`,
// `send` and `waitAny`, so plumbing them together needs no new capability. Both examples were
// written against the existing world without touching it, which is the evidence.
//
// The children are platform's own `wc.wac` rather than `box`, so platform's tests do not
// depend on a package that depends on platform.

import { buildApp } from "../build.ts";
// Imported for its side effect: retries a spawn that fails with "Text file busy" and names
// whoever held the file, if anyone did. wac-mono 0074.
import "../../../harness/spawnRetry.ts";
import { freePort } from "../../../harness/port.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

const dec = new TextDecoder();

Deno.test("stdin -> child -> child -> stdout, with three handles live at once", async () => {
  const pipe = await Deno.makeTempFile({ prefix: "wac-pipe-" });
  const child = await Deno.makeTempFile({ prefix: "wac-wc-", suffix: ".worker.js" });
  try {
    await buildApp("packages/platform/example/pipe.wac", pipe, { read: true });
    await buildApp("packages/platform/example/wc.wac", child, {}, "deno", true);

    const p = new Deno.Command(pipe, {
      // Empty args: `wc` with no arguments reads standard input, which is the point here.
      args: [child, "", ""],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    const w = p.stdin.getWriter();
    await w.write(new TextEncoder().encode("one two three\n"));
    await w.close();

    // Both streams drained before `status`, or a full pipe buffer deadlocks the test rather
    // than failing it. That has cost this suite three hangs.
    const [out, err, st] = await Promise.all([p.stdout, p.stderr, p.status].map((x) =>
      x instanceof Promise ? x : new Response(x).arrayBuffer()
    ) as [Promise<ArrayBuffer>, Promise<ArrayBuffer>, Promise<Deno.CommandStatus>]);

    assertEquals(st.code, 0, dec.decode(err));
    // `wc` of "one two three\n" is "1 3 14"; `wc` of that is "1 3 7". The second number
    // proves the bytes went *through* the first child rather than around it.
    assertEquals(dec.decode(out).trim(), "1 3 7", dec.decode(out));
  } finally {
    for (const f of [pipe, child]) await Deno.remove(f);
  }
});

Deno.test("a child serves a socket it cannot see", async () => {
  const inetd = await Deno.makeTempFile({ prefix: "wac-inetd-" });
  const child = await Deno.makeTempFile({ prefix: "wac-wc-", suffix: ".worker.js" });
  try {
    await buildApp("packages/platform/example/inetd.wac", inetd, { read: true, net: true });
    await buildApp("packages/platform/example/wc.wac", child, {}, "deno", true);

    // A port the OS just confirmed is free. Racy in principle; the alternative is a fixed
    // port that collides with the other agents sharing this container, which is worse.
    // `freePort`: this port goes to a spawned `inetd`, so the close-then-bind window is 0069's race.
    const port = freePort();

    const p = new Deno.Command(inetd, {
      args: [String(port), child],
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    // Read stderr as it arrives so the wait has something to wait *on*. Polling the port
    // instead would connect before `accept` and be indistinguishable from a hang.
    let log = "";
    const reading = (async () => {
      for await (const c of p.stderr) log += dec.decode(c);
    })();
    const deadline = Date.now() + 20_000;
    while (!log.includes("listening") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assertEquals(log.includes("listening"), true, `inetd never listened: ${log}`);

    const conn = await Deno.connect({ hostname: "127.0.0.1", port });
    await conn.write(new TextEncoder().encode("one two three\n"));
    // Half-close: the handler's input ends, the handler's answer still has to come back.
    // `wc` writes nothing before EOF, so without this the exchange would return empty.
    await conn.closeWrite();
    const reply = dec.decode(new Uint8Array(await new Response(conn.readable).arrayBuffer()));

    const [out, st] = await Promise.all([
      new Response(p.stdout).arrayBuffer(),
      p.status,
      reading,
    ]);
    assertEquals(st.code, 0, log);
    assertEquals(reply.trim(), "1 3 14", reply);
    // The handler's output went to the socket, not to the terminal it was launched from.
    assertEquals(dec.decode(out), "", dec.decode(out));
  } finally {
    for (const f of [inetd, child]) await Deno.remove(f);
  }
});
