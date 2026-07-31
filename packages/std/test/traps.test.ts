// The traps in Vec, Option and Result. Host-side because a trap aborts the module, so a wac
// test cannot assert one and keep running.

import { wacBind } from "../../../harness/wacBind.ts";

const m = await wacBind("packages/std/test/traps.wac") as Record<string, () => number>;

function assertTraps(name: string): void {
  try {
    m[name]();
  } catch (e) {
    const msg = (e as Error).message;
    if (!/unreachable|out of bounds|RuntimeError/i.test(msg) && !(e instanceof WebAssembly.RuntimeError)) {
      throw new Error(`${name} threw something unexpected: ${msg}`);
    }
    return;
  }
  throw new Error(`${name} returned instead of trapping`);
}

function assertEq(name: string, want: number): void {
  const got = m[name]();
  if (got !== want) throw new Error(`${name}: got ${got}, expected ${want}`);
}

Deno.test("Vec bounds checks are against the length, not the capacity", () => {
  assertTraps("getPastEnd");
  assertTraps("getNegative");
  // The one a wac-written test cannot reach: inside the allocation, past the length.
  assertTraps("getAtCapacityNotLength");
  assertTraps("setPastEnd");
  assertTraps("removePastEnd");
  assertTraps("swapRemovePastEnd");
  // insert accepts `len` and nothing above it, which is one index further than the others.
  assertTraps("insertPastEnd");
  assertTraps("negativeCapacity");
});

Deno.test("Vec's in-range operations return rather than trapping", () => {
  assertEq("getOk", 42);
  assertEq("setOk", 7);
  assertEq("insertAtLenOk", 9);
});

Deno.test("unwrap traps on absence and returns otherwise", () => {
  assertTraps("unwrapNone");
  assertTraps("unwrapErr");
  assertEq("unwrapSomeOk", 5);
  assertEq("unwrapOkOk", 6);
});
