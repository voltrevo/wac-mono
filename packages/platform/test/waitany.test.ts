// `waitAny` from a wac program, over two real sockets.
//
// `test/ring.test.ts` covers the transport: submit does not block, completions arrive out
// of order, a spent ticket is refused. What it cannot show is a *wac* program parking on
// whichever of several answers first, which is the whole reason the ring exists — `nc`, an
// SSH relay and a shell all need exactly that, and `isDone` in a loop is a spin, not a
// wait.
//
// The two listeners answer at different speeds and the client is given them in the *wrong*
// order on purpose: index order and speed order disagree, so a `waitAny` that quietly
// returned "the first one you passed" would pass a test where they agreed.

import { withDeadline } from "../../../harness/deadline.ts";
import { buildApp } from "../build.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

/** Answer once, after `delay`, then hold the connection open briefly and close. */
function serveOnce(delay: number, msg: string): { port: number; done: Promise<void> } {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  const done = (async () => {
    try {
      // Bounded: without it, a test that never dials leaves this `accept()` outstanding for ever and
      // Deno has no per-test timeout to notice. 0036.
      const c = await withDeadline(l.accept(), `a client on port ${port}`);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      await c.write(new TextEncoder().encode(msg + "\n"));
      // Held open so the *other* recv is still outstanding when the first is collected.
      await new Promise((r) => setTimeout(r, 900));
      c.close();
    } catch { /* the client may have gone first */ }
    try { l.close(); } catch { /* already closed */ }
  })();
  return { port, done };
}

Deno.test("waitAny parks until whichever socket speaks first", async () => {
  const built = await Deno.makeTempFile({ prefix: "wac-waitany-" });
  try {
    await buildApp("packages/platform/example/whichever.wac", built, { net: true });

    const quick = serveOnce(0, "quick");
    const slow = serveOnce(400, "slow");

    // Slow port first, so its ticket is index 0 while the *fast* answer is index 1.
    // `output()` and not `outputSync()`: the listeners are async tasks on this event loop,
    // and a synchronous wait blocks the loop that has to accept.
    const r = await new Deno.Command(built, {
      args: [`${slow.port}`, `${quick.port}`],
      stdout: "piped",
      stderr: "piped",
    }).output();
    await Promise.allSettled([quick.done, slow.done]);

    const out = new TextDecoder().decode(r.stdout).trimEnd().split("\n");
    assertEquals(r.code, 0, new TextDecoder().decode(r.stderr));
    assertEquals(out[0], "first=1 said=quick", `wrong first answer: ${out.join(" | ")}`);
    // The slower ticket was never cancelled and is still collectable afterwards.
    assertEquals(out[1], "second=0 said=slow", `wrong second answer: ${out.join(" | ")}`);
  } finally {
    await Deno.remove(built);
  }
});

