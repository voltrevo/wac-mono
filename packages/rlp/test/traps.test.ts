// `fromI64` refuses a negative, checked from the host because a trap ends the module.
//
// See `test/wac/traps.wac` for why this matters more than it looks: without the guard a negative encodes as
// the empty string, which is RLP's spelling of zero. Not an error, not a malformed encoding — a valid
// encoding of a different number, which nothing downstream can notice.

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

const m = await wacBind("packages/rlp/test/wac/traps.wac") as Record<string, () => number>;

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

Deno.test("a negative integer is refused rather than encoded as zero", () => {
  for (const name of ["negativeOne", "mostNegative", "negativeInAList"]) assertTraps(name);
});

Deno.test("and an ordinary number still encodes", () => {
  // The control. Every case above would pass if the module trapped on load or `fromI64` trapped for
  // everything, and then this file would be checking nothing at all — 258 is two bytes, `01 02`.
  assertEquals(m.ordinary(), 2, "fromI64(258) should be two bytes");
});
