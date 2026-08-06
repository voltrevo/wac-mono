// The guards that trap, driven one call at a time.
//
// A trap aborts the module, so a wac test cannot assert one and keep running — this is the same host-side
// shape `packages/std/test/traps.test.ts` and `packages/json/test/bounds.test.ts` use.
//
// Every case here was a surviving mutant before the file existed. A guard against a caller error is exactly
// the code nothing exercises by accident, and "it traps, obviously" is a claim rather than a check: deleting
// `hashInto`'s length check leaves every other test in this package passing.

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

const m = await wacBind("packages/ens/test/wac/traps.wac") as Record<string, () => number>;

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

Deno.test("a node that is not 32 bytes is refused everywhere it is taken", () => {
  // **Both directions, and the long one is the point.** A *short* node traps whatever the guard does, because
  // the copy loop reads past its end — so a fixture of short nodes alone leaves every length check deletable
  // with the tests still green, which is exactly what the first version of this file did. An *over-long* node
  // is copied happily and truncated to its first 32 bytes: a plausible hash of the wrong thing, which for a
  // registry read means proving something true about a different name.
  for (
    const name of [
      "hashIntoShortNode",
      "hashIntoShortLabel",
      "hashIntoLongNode",
      "hashIntoLongLabel",
      "resolverCallShort",
      "resolverCallLong",
      "addrCallShort",
      "addrCallLong",
      "ownerSlotShort",
      "ownerSlotLong",
      "resolverSlotShort",
      "resolverSlotLong",
    ]
  ) assertTraps(name);
});

Deno.test("a DNS label longer than the wire format can express traps, and 255 does not", () => {
  assertTraps("dnsLabelTooLong");
  // The boundary below it: one length byte, 255 bytes of label, one terminator.
  assertEquals(m.dnsLabelAtTheLimit(), 257, "a 255-byte label is the longest there is");
});

Deno.test("and the ordinary calls do not trap, so the fixture is not vacuous", () => {
  // A fixture whose every case traps for some unrelated reason would pass the two tests above and check
  // nothing. `foo.eth` is nine bytes: two labels, two length prefixes, one terminator.
  assertEquals(m.ordinary(), 9, "dnsEncode(\"foo.eth\")");
});
