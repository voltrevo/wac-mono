// The container bounds checks. Host-side because a trap aborts the module, so a wac
// test cannot assert one and keep running.

import { wacBind } from "../../../harness/wacBind.ts";

const m = await wacBind("packages/json/test/bounds.wac") as Record<string, () => number>;

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

Deno.test("JsonArray.at and JsonObject.at trap outside the range", () => {
  // `count`, not the backing array's length: the containers over-allocate, so an
  // index between count and capacity is inside the allocation and must still trap.
  for (const n of ["arrayPastEnd", "arrayNegative", "objectPastEnd", "objectNegative"]) {
    assertTraps(n);
  }
});

Deno.test("at returns the element when in range", () => {
  if (m.arrayOk() !== 1) throw new Error(`expected 1, got ${m.arrayOk()}`);
});
