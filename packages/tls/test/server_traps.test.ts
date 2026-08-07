// `server.wac`'s framing guards, from the host, because a trap ends the module.
//
// Twelve of these were reported "not covered" — nothing executed the line at all — on the side that
// accepts connections from strangers. See `test/wac/server_traps.wac` for the one among them that was not
// a guard against a caller error but a **remote abort**: an alert followed by any further record in the
// same flight put both into one `tlsServerFeed`, and the second fell through the phase dispatch to a trap.

import { wacBind } from "../../../harness/wacBind.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

const m = await wacBind("packages/tls/test/wac/server_traps.wac") as Record<string, () => number>;

function assertTraps(name: string): void {
  try {
    m[name]();
  } catch (e) {
    if (!(e instanceof WebAssembly.RuntimeError) && !/unreachable|out of bounds/i.test((e as Error).message)) {
      throw new Error(`${name} threw something unexpected: ${(e as Error).message}`);
    }
    return;
  }
  throw new Error(`${name} returned instead of trapping`);
}

Deno.test("malformed framing traps rather than being read past", () => {
  for (const name of ["shortHeader", "lengthPastEnd", "wrongTypeAtStart", "messageLengthMismatch",
                      "notAClientHello"]) {
    assertTraps(name);
  }
});

Deno.test("a closed connection takes no more bytes, and does not abort", () => {
  // The one that is not a caller error: a peer sends an alert and one more record in a single flight,
  // both land in one `tlsServerFeed`, and before the fix the second one killed the module. Checking the
  // phase between calls cannot help when both records are inside one call.
  assertEquals(m.closedTakesNoMore(), 1, "a closed server should stay closed and keep answering");
});

Deno.test("and a fresh connection still starts", () => {
  assertEquals(m.ordinary(), 0, "a new server is in the start phase");
});
