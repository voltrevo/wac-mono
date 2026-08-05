// What the port allocator promises, and the one thing it cannot.
//
// wac-mono 0069. The property that matters is that a held port cannot be taken by anybody — including
// another test file running in parallel, which is the collision that actually happened. The window
// between release and bind is still there (closing it needs an inherited descriptor), so `withPort`'s
// retry is tested too.
//
// **These tests must not themselves race**, which the first version of this file did: it called
// `freePort()` and then bound the number in a separate step, 200 times, which is exactly the shape the
// allocator exists to avoid — and it duly failed at five workers. A test of an allocator has to use the
// allocator's own contract, so uniqueness is checked against what it returns, and bindability is checked
// through `holdPort`, where the listener is already open.

import { freePort, holdPort, isAddrInUse, withPort } from "./port.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

Deno.test("a held port is bound, so nothing else can take it", () => {
  const held = holdPort();
  try {
    assertEquals(held.port >= 49152 && held.port <= 65535, true, `${held.port} is outside the range`);
    // Proof that it is held rather than merely chosen: a second bind of the same port must fail. This is
    // the property the old version did not have and the reason the race was reachable at all.
    let refused = false;
    try {
      Deno.listen({ hostname: "127.0.0.1", port: held.port }).close();
    } catch (e) {
      refused = isAddrInUse(e);
    }
    assertEquals(refused, true, `port ${held.port} was not actually held`);
  } finally {
    held.release();
  }
});

Deno.test("release makes the port usable, and is idempotent", () => {
  const held = holdPort();
  held.release();
  held.release(); // a caller that also releases in a `finally` is being careful, not wrong
  const l = Deno.listen({ hostname: "127.0.0.1", port: held.port });
  assertEquals((l.addr as Deno.NetAddr).port, held.port);
  l.close();
});

Deno.test("no port is handed out twice, even after release", () => {
  const seen = new Set<number>();
  const held: ReturnType<typeof holdPort>[] = [];
  try {
    // Held all at once rather than one at a time: this is what several tests in one file look like, and
    // it proves the bookkeeping and the kernel agree.
    for (let i = 0; i < 40; i++) {
      const h = holdPort();
      assertEquals(seen.has(h.port), false, `port ${h.port} was handed out twice`);
      seen.add(h.port);
      held.push(h);
    }
    assertEquals(seen.size, 40);
  } finally {
    for (const h of held) h.release();
  }
  // And after releasing them all, the same numbers are not offered again — `port: 0` would have.
  const after = freePort();
  assertEquals(seen.has(after), false, `port ${after} came back after being released`);
});

Deno.test("withPort retries a bind failure and gives up on anything else", async () => {
  const offered: number[] = [];
  const port = await withPort((p) => {
    offered.push(p);
    if (offered.length === 1) {
      return Promise.reject(new Deno.errors.AddrInUse("Address already in use"));
    }
    return Promise.resolve(p);
  });
  assertEquals(offered.length, 2);
  assertEquals(offered[0] === offered[1], false, "the retry reused the port it had just been refused");
  assertEquals(port, offered[1]);

  let calls = 0;
  let threw = "";
  try {
    await withPort(() => {
      calls++;
      return Promise.reject(new Error("the server said no for its own reasons"));
    });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  assertEquals(calls, 1, "a real failure was retried");
  assertEquals(threw, "the server said no for its own reasons");
});

Deno.test("isAddrInUse reads a child's words as well as Deno's error", () => {
  assertEquals(isAddrInUse(new Deno.errors.AddrInUse("x")), true);
  // What a spawned server actually prints, which is the form the shell-level callers see.
  assertEquals(isAddrInUse(new Error("bind: Address already in use (os error 98)")), true);
  assertEquals(isAddrInUse("listen EADDRINUSE: address already in use 127.0.0.1:8080"), true);
  assertEquals(isAddrInUse(new Error("connection refused")), false);
  assertEquals(isAddrInUse(new Error("no such file or directory")), false);
});
