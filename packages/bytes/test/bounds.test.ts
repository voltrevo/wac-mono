// Buf's bounds checks. Host-side because a trap aborts the module, so a wac test
// cannot assert one and keep running.

import { wacBind } from "../../../harness/wacBind.ts";

const m = await wacBind("packages/bytes/test/bounds.wac") as Record<string, () => number>;

function assertTraps(name: string): void {
  try {
    m[name]();
  } catch (e) {
    const msg = (e as Error).message;
    // Any wasm trap is acceptable; what matters is that it did not return a value.
    if (!/unreachable|out of bounds|RuntimeError/i.test(msg) && !(e instanceof WebAssembly.RuntimeError)) {
      throw new Error(`${name} threw something unexpected: ${msg}`);
    }
    return;
  }
  throw new Error(`${name} returned instead of trapping`);
}

Deno.test("Buf.get traps outside the written range", () => {
  assertTraps("getPastEnd");
  assertTraps("getNegative");
  // The one that matters: inside the allocation, past the length. A check against
  // data.len() instead of len would return uninitialised zero here.
  assertTraps("getAtCapacityNotLength");
});

Deno.test("Buf.get returns the byte when in range", () => {
  if (m.getOk() !== 42) throw new Error(`expected 42, got ${m.getOk()}`);
});

Deno.test("Buf.pushRepeat traps outside the written range", () => {
  // The source has to be bytes that exist. Reading before the start or past the length would
  // copy uninitialised zeros into the output, which for a decompressor means a match that
  // silently produces the wrong bytes rather than a stream that is refused.
  assertTraps("pushRepeatBeforeStart");
  assertTraps("pushRepeatPastEnd");
  assertTraps("pushRepeatNegativeCount");
});
