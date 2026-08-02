// Circuit reuse and retirement policy.
//
// The policy is separated from the plumbing precisely so it can be tested like this: no
// network, no clock of its own, every input explicit. What is checked is mostly what must
// *not* happen — sharing across isolation keys, and a circuit staying usable past its
// lifetime — because those are the failures that leave a working client.

import { MAX_DIRTINESS_MS, retirable, selectCircuit } from "../host/pool.ts";

function assert(cond: boolean, msg = "assertion failed"): void {
  if (!cond) throw new Error(msg);
}
function assertEquals<T>(got: T, want: T, msg?: string): void {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) throw new Error(`${msg ?? "assertEquals failed"}\n  got:  ${g}\n  want: ${w}`);
}

type E = { id: string; isolation: string; firstUsed: number | null; broken: boolean };
const e = (id: string, isolation: string, firstUsed: number | null, broken = false): E =>
  ({ id, isolation, firstUsed, broken });

const T0 = 1_000_000_000_000;

Deno.test("two isolation keys never share a circuit", () => {
  // The guarantee the whole mechanism exists for. A caller that separates two activities
  // must get separate exits, or the exit links them.
  const entries = [e("a", "alpha", T0), e("b", "beta", T0)];
  assertEquals(selectCircuit(entries, "alpha", T0)!.id, "a");
  assertEquals(selectCircuit(entries, "beta", T0)!.id, "b");
  assertEquals(
    selectCircuit(entries, "gamma", T0),
    null,
    "an unseen key gets nothing rather than the nearest circuit",
  );
});

Deno.test("a circuit stops taking new streams at MaxCircuitDirtiness", () => {
  const entries = [e("old", "x", T0)];
  assert(selectCircuit(entries, "x", T0 + MAX_DIRTINESS_MS - 1) !== null, "usable just before");
  assertEquals(
    selectCircuit(entries, "x", T0 + MAX_DIRTINESS_MS),
    null,
    "and not at the boundary — everything on one circuit shares an exit, and the bound is " +
      "on how much that exit gets to correlate",
  );
  assertEquals(selectCircuit(entries, "x", T0 + MAX_DIRTINESS_MS * 2), null, "nor later");
});

Deno.test("a clean circuit never expires, because its clock has not started", () => {
  const entries = [e("clean", "x", null)];
  assert(selectCircuit(entries, "x", T0 + MAX_DIRTINESS_MS * 100) !== null,
    "dirtiness is measured from first use, not from construction");
});

Deno.test("a broken circuit is never handed out", () => {
  const entries = [e("bad", "x", null, true), e("good", "x", T0)];
  assertEquals(selectCircuit(entries, "x", T0)!.id, "good");
  assertEquals(selectCircuit([e("bad", "x", null, true)], "x", T0), null);
});

Deno.test("dirty circuits are used before clean ones, oldest first", () => {
  // So circuits are used up and retired in order. Preferring the clean one would keep it
  // permanently warm while the others expired unused, which means more circuits built and
  // more relays seeing a piece of the traffic.
  const entries = [e("clean", "x", null), e("newer", "x", T0 + 1000), e("older", "x", T0)];
  assertEquals(selectCircuit(entries, "x", T0 + 2000)!.id, "older");
  assertEquals(
    selectCircuit([e("clean", "x", null), e("expired", "x", T0)], "x", T0 + MAX_DIRTINESS_MS)!.id,
    "clean",
    "the clean one is used once the dirty one is past its life",
  );
});

Deno.test("a circuit still carrying a stream is not retired under it", () => {
  // Retirement is about new streams. A download running for an hour keeps its circuit; what
  // stops is anything else joining it.
  const entries = [e("busy", "x", T0), e("idle", "x", T0)];
  const busy = (x: E) => x.id === "busy";
  const due = retirable(entries, T0 + MAX_DIRTINESS_MS, busy);
  assertEquals(due.map((d) => d.id), ["idle"], "only the idle one is retired");

  assertEquals(
    retirable(entries, T0 + 1000, busy).map((d) => d.id),
    [],
    "and nothing is retired before its time",
  );
});

Deno.test("a broken circuit is retired even while a stream is open on it", () => {
  // It cannot carry anything anyway — the digest is out of step or the peer is gone — so
  // holding it open leaks a socket and hides the failure.
  const entries = [e("bad", "x", T0, true)];
  assertEquals(retirable(entries, T0, () => true).map((d) => d.id), ["bad"]);
});
