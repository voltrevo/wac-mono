// The slot count is in two places, and they have to agree.
//
// `host/layout.ts` decides how many control records the shared buffer holds; `src/platform.wac` states the
// same number as `CALL_SLOTS` so a guest can derive its own limits from it instead of transcribing one.
// Two copies of a number that has already changed twice is exactly the shape that goes stale quietly: the
// guest would keep watching twelve sockets on a ring of 128, or — far worse in the other direction —
// submit more calls than there are slots and park for ever with the held slots unable to complete.
//
// Checked by reading the wac source as text, the way `order.test.ts` checks the field order it depends on.
// A compile would be a heavier way to learn the same thing.

import { SLOTS } from "../host/layout.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

Deno.test("platform.wac's CALL_SLOTS is the ring's real size", async () => {
  const src = await Deno.readTextFile("packages/platform/src/platform.wac");
  const m = /export const i32 CALL_SLOTS = (\d+);/.exec(src);
  if (m === null) throw new Error("platform.wac no longer declares CALL_SLOTS");
  assertEquals(
    Number(m[1]),
    SLOTS,
    "platform.wac says one thing and layout.ts another; a guest sizing itself from the wrong one deadlocks",
  );
});
