// Bounding a call, and the sharp edge that comes with it. wac-mono issue 0018.
//
// The capability is `core.sleepMillis`: a ticket that settles on time rather than on I/O, so
// `waitAny` over it and a real call is a timeout. What is worth testing is not that a timer
// fires — it is the two failure modes around it, both of which are silent permanent parks:
//
//   * a silent peer, which is what the issue was filed about;
//   * a ticket `waitAny` did not pick and nobody cancelled, which holds a ring slot for good.
//
// The second is the one I hit writing the example, and it looks exactly like the first.

import { buildApp } from "../build.ts";
import { newBridge } from "../host/layout.ts";
import { S_STATUS, SLOTS, slotAt, ST_READY } from "../host/layout.ts";
import { submit } from "../host/call.ts";

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

/**
 * A peer that completes the handshake and then says nothing, or speaks once after a delay.
 *
 * Deliberately not a `Deno.serve` or anything with its own timeouts — the whole point is a
 * connection that stays open and idle, which is the case no library gives you by accident.
 */
function silentPeer(speakAfterMs = 0) {
  const l = Deno.listen({ port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  const held: Deno.Conn[] = [];
  const serving = (async () => {
    for await (const c of l) {
      held.push(c);
      if (speakAfterMs > 0) {
        setTimeout(() => {
          c.write(new TextEncoder().encode("finally\n")).catch(() => {/* client left */});
        }, speakAfterMs);
      }
    }
  })();
  return {
    port,
    async close() {
      l.close();
      for (const c of held) {
        try { c.close(); } catch { /* already gone by the client's close */ }
      }
      await serving.catch(() => {/* the listener closing ends the loop */});
    },
  };
}

Deno.test("a peer that says nothing no longer wedges the application", async () => {
  const app = await Deno.makeTempFile({ prefix: "wac-patience-" });
  const peer = silentPeer();
  try {
    await buildApp("packages/platform/example/patience.wac", app, { net: true });

    const began = performance.now();
    const r = await new Deno.Command(app, {
      // Six rounds of 100ms. Six is more than the ring has slots, so a run that leaked a
      // ticket per round would stop partway instead of finishing — which is what the first
      // version of the example did, and it is why the round count is above SLOTS.
      args: ["127.0.0.1", String(peer.port), "100"],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const took = performance.now() - began;

    const out = dec.decode(r.stdout);
    assertEquals(r.code, 1, dec.decode(r.stderr));
    assertEquals(out.includes("giving up after 600ms"), true, out);
    // Bounded is the whole claim; before `sleepMillis` this ran until killed. Generous,
    // because it is a process launch and this box is shared — the failure it distinguishes
    // is "never", not "slow".
    assertEquals(took < 15_000, true, `took ${Math.round(took)}ms`);
    // Every round ran. Five "nothing yet" lines and then the verdict: if a leaked slot had
    // stalled it, the count would be short rather than the run being obviously broken.
    assertEquals(out.split("nothing yet").length - 1, 5, out);
  } finally {
    await peer.close();
    await Deno.remove(app);
  }
});

Deno.test("a peer that speaks late is still heard", async () => {
  const app = await Deno.makeTempFile({ prefix: "wac-patience-" });
  const peer = silentPeer(250);
  try {
    await buildApp("packages/platform/example/patience.wac", app, { net: true });
    const r = await new Deno.Command(app, {
      // 100ms of patience per round against a peer that takes 250ms: the read wins on a
      // later round, which is the case that proves re-waiting one ticket works.
      args: ["127.0.0.1", String(peer.port), "100"],
      stdout: "piped",
      stderr: "piped",
    }).output();

    const out = dec.decode(r.stdout);
    assertEquals(r.code, 0, dec.decode(r.stderr));
    assertEquals(out.includes("peer sent 8 bytes"), true, out);
  } finally {
    await peer.close();
    await Deno.remove(app);
  }
});

Deno.test("every slot holding an uncollected answer is an error, not a park", () => {
  // The diagnostic, unit-tested: no worker and no wac, because the condition is a state of
  // the control block and putting it there directly is exact.
  //
  // A ready slot can only be freed by the thread that submitted, so a submitting thread that
  // finds all of them ready is waiting for something that can only happen after it stops
  // waiting. It used to park there forever — the same silent hang as the bug this file is
  // about, arrived at from the other direction.
  const b = newBridge();
  for (let i = 0; i < SLOTS; i++) Atomics.store(b.ctrl, slotAt(i) + S_STATUS, ST_READY);

  let message = "";
  try {
    submit(b, 1, new Uint8Array(0));
    throw new Error("submit returned; it should have refused");
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  // The message has to name the fix, because the symptom points at whatever call happened to
  // run out of slots rather than at the ticket that was abandoned rounds earlier.
  assertEquals(message.includes("never taken"), true, message);
  assertEquals(message.includes("cancel"), true, message);
});
