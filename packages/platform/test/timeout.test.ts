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
import { onWorker, SLOW, slowHandlers } from "./worker.ts";
import { newBridge } from "../host/layout.ts";
import { S_STATUS, SLOTS, slotAt, ST_READY } from "../host/layout.ts";
import { submit } from "../host/call.ts";
// Imported for its side effect: retries a spawn that fails with "Text file busy" and names
// whoever held the file, if anyone did. wac-mono 0074.
import "../../../harness/spawnRetry.ts";

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

Deno.test("the deadline on the wait, from a worker where parking is real", async () => {
  // `waitAny`'s own timing, which the end-to-end test above cannot pin down: it always passes
  // a positive deadline against a real socket, so an off-by-one in the remaining-time check
  // would still look right there. Here the call takes a known 400ms and the waits are exact.
  const out = await onWorker(
    `
    const t = submit(b, ${SLOW}, i32le(400));
    const log = [];

    // Short of the answer: -1, and it waited rather than returning at once.
    const began = performance.now();
    log.push(waitAny(b, [t], 60) === null ? "timeout" : "settled");
    log.push(performance.now() - began >= 50 ? "parked" : "returned-early");

    // Zero is a poll of the set, not a wait that always fails.
    log.push(waitAny(b, [t], 0) === null ? "not-ready" : "ready");

    // -1 waits as long as it takes.
    const got = waitAny(b, [t], -1);
    log.push(got === null ? "gave-up" : "got-it");
    log.push(String(readI32le(collect(b, t))));

    // A poll of a settled ticket reports it instead of timing out — the deadline is checked
    // after the scan, so an answer already there is never missed however tight the budget.
    const u = submit(b, ${SLOW}, i32le(0));
    waitAny(b, [u], -1);
    log.push(waitAny(b, [u], 0) === null ? "missed" : "seen");
    collect(b, u);

    // Nothing to wait for is the same answer as nothing happened in time.
    log.push(waitAny(b, [], -1) === null ? "empty-is-null" : "empty-is-something");
    return log.join(",");
  `,
    slowHandlers,
  );
  assertEquals(
    out,
    "timeout,parked,not-ready,got-it,400,seen,empty-is-null",
    String(out),
  );
});

Deno.test("the exhaustion error names what is holding the slots", async () => {
  // The state-of-the-control-block test above sets statuses directly, so its slots carry no
  // opcode and it cannot check the naming. This fills the ring the way a program would —
  // four calls settled and deliberately not collected — so the message has real opcodes to
  // report. The harness's slow capability borrows opcode 1, which is `NOW_MILLIS`: the
  // behaviour is a test double, the number is genuine, and that is what the table resolves.
  const out = await onWorker(
    `
    const ts = [];
    for (let i = 0; i < ${SLOTS}; i++) ts.push(submit(b, ${SLOW}, i32le(0)));
    for (const t of ts) waitAny(b, [t], -1);      // settled, and left holding their slots
    try { submit(b, ${SLOW}, i32le(0)); return "submitted anyway"; }
    catch (e) { return e.message; }
  `,
    slowHandlers,
  );
  const msg = String(out);
  // One name per slot, from `SLOTS` rather than a literal: the count is a tuning decision
  // and a test that pins it would fail for the wrong reason when it changes.
  const names = new Array(SLOTS).fill("NOW_MILLIS").join(", ");
  assertEquals(msg.includes(`from: ${names}`), true, msg);
  // And it says the blame is probably elsewhere, because it is.
  assertEquals(msg.includes("abandoned ticket is usually earlier"), true, msg);
});
