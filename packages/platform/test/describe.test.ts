// The stall report, which had no test at all.
//
// `describeSlots` is what a hung run prints — `harness/appRun.ts` narrates it, and the scheduler asks
// every bridge for one when nothing has moved. It decides nothing, so it was never tested, and that is
// exactly why it is worth testing: a diagnostic that lies costs more than one that is missing, because
// the reader believes it.
//
// It has lied. The label table was indexed by the order the constants happened to be declared in, so
// `ST_RUNNING` (2) printed as "pending" — and those two words mean opposite things. "Pending" is the host
// has not taken the call; "running" is the host took it and the handler never came back. wac-mono 0082 was
// read backwards for an hour on the strength of it. The first test below is that bug, stated.
//
// Checked by putting it back: a table written in *lifecycle* order — free, claimed, pending, running,
// ready, cancelled — and indexed by the status value prints `1:pending` for a slot that is running, and
// three of the four tests here fail. (Writing it in *declaration* order happens to be right today, since
// the constants are declared 0..5 in order; it was not when `ST_CLAIMED` was declared second and valued
// five, which is how the bug got in.)

import {
  newBridge,
  S_GEN,
  S_OP,
  S_REQ_LEN,
  S_STATUS,
  SLOTS,
  slotAt,
  ST_CANCELLED,
  ST_CLAIMED,
  ST_PENDING,
  ST_READY,
  ST_RUNNING,
} from "../host/layout.ts";
import { describeSlots } from "../host/call.ts";
import { OP } from "../host/ops.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

/** Put a slot in a state directly. The report reads memory and nothing else, so this is the whole setup. */
function put(b: ReturnType<typeof newBridge>, slot: number, status: number, op: number): void {
  const at = slotAt(slot);
  Atomics.store(b.ctrl, at + S_STATUS, status);
  Atomics.store(b.ctrl, at + S_OP, op);
  Atomics.store(b.ctrl, at + S_REQ_LEN, 0);
  Atomics.store(b.ctrl, at + S_GEN, 0);
}

Deno.test("every status prints its own name, not the one next to it", () => {
  const b = newBridge();
  const states: [number, string][] = [
    [ST_PENDING, "pending"],
    [ST_RUNNING, "running"],
    [ST_READY, "ready"],
    [ST_CANCELLED, "cancelled"],
    [ST_CLAIMED, "claimed"],
  ];
  states.forEach(([st], i) => put(b, i, st, OP.READ_FILE));
  const said = describeSlots(b);
  states.forEach(([, name], i) => {
    assertEquals(
      said.includes(`${i}:${name}:`),
      true,
      `slot ${i} should read "${name}": ${said}`,
    );
  });
  // And the pair whose confusion inverts a diagnosis is checked from the other side too: whatever slot 2
  // is, it is not the word that means the opposite.
  assertEquals(said.includes("1:running:"), true, said);
  assertEquals(said.includes("1:pending:"), false, said);
});

Deno.test("a free ring says so, with the counters that tell a parked host from a dead one", () => {
  const b = newBridge();
  const said = describeSlots(b);
  assertEquals(said.startsWith("no slot in use"), true, said);
  // The counters are the difference between "the host is busy" and "the host stopped": a reader compares
  // them across two reports, so they have to be there even when nothing is in flight.
  assertEquals(/submit=\d+ done=\d+/.test(said), true, said);
});

Deno.test("a full ring is a tally, not 128 lines of the same thing", () => {
  // The case this exists for: every slot holding the same kind of call. Before the ring grew to 128 that
  // was sixteen entries and merely noisy; four bridges of 128 is a page of scrollback, and the cycle a
  // reader is looking for is between the bridges rather than inside one.
  const b = newBridge();
  for (let i = 0; i < SLOTS; i++) put(b, i, ST_RUNNING, OP.RECV);
  const said = describeSlots(b);

  // The first few keep their slot numbers, because that is what lines one report up against another.
  assertEquals(said.startsWith("0:running:RECV 1:running:RECV"), true, said);
  assertEquals(said.includes(`RECV × ${SLOTS - 12}`), true, said);
  // Short enough to read: the whole point is that it fits on a line or two.
  assertEquals(said.length < 400, true, `${said.length} chars: ${said}`);
});

Deno.test("distinct kinds are counted separately, since which call is stuck is the question", () => {
  const b = newBridge();
  for (let i = 0; i < 20; i++) put(b, i, ST_RUNNING, OP.RECV);
  for (let i = 20; i < 26; i++) put(b, i, ST_PENDING, OP.WRITE_FILE);
  const said = describeSlots(b);
  assertEquals(said.includes("running:RECV × 8"), true, said);
  assertEquals(said.includes("pending:WRITE_FILE × 6"), true, said);
});
