// `wire.wac`'s bounds checks, from the host, because a trap ends the module.
//
// `wire.wac`'s header says the reader "bounds-checks every read against the enclosing slice and traps
// rather than returning a short value", and names that as the thing almost every TLS parsing bug comes
// from. The claim was true and unverified: `u8`'s end check, both of `take`'s, and all three of the
// writer's length limits survived mutation testing. This is the file that makes the header a test.

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

const m = await wacBind("packages/tls/test/wac/wire_traps.wac") as Record<string, () => number>;

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

Deno.test("a read past the end traps rather than returning a short value", () => {
  for (const name of ["u8PastEnd", "u16PastEnd", "takePastEnd", "takeNegative",
                      "slicePastEnd", "sliceNegative"]) {
    assertTraps(name);
  }
});

Deno.test("a sub-reader cannot see past its own end", () => {
  // The buffer under it has eight more bytes. A `Reader` that checked against `buf.len()` instead of its
  // own `end` would read them, which is how one extension's parser comes to read the next one's bytes.
  assertTraps("sliceIsBounded");
});

Deno.test("a length prefix larger than what follows is refused", () => {
  // What the header is really about: the prefix and the payload come from the same attacker. "Nine bytes
  // follow" with three present has to stop here rather than run off the end of the enclosing slice.
  for (const name of ["vec8Overruns", "vec16Overruns", "vec24Overruns"]) assertTraps(name);
});

Deno.test("the writer refuses a vector that does not fit its own prefix", () => {
  // A `vec8` of 256 bytes would write `0x00` and then 256 bytes: the reader on the other side sees an
  // empty vector followed by garbage, which is a protocol desynchronisation rather than an error.
  for (const name of ["writeVec8TooLong", "writeVec16TooLong", "writeVec24TooLong"]) assertTraps(name);
});

Deno.test("and an ordinary round trip still works", () => {
  // The control: without it, a module that trapped on everything would pass every case above.
  assertEquals(m.ordinary(), 34, "vec8 of 3 and vec16 of 4, written then read back");
});
