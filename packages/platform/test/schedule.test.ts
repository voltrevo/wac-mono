// The scheduler's policies, and the log that makes a run explainable.
//
// design/0001 D12. The scheduler decides which ready answer is delivered next, so the order the whole
// system runs in is a choice rather than a race. These are the claims that choice has to keep.

import { newScheduler } from "../host/schedule.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("off delivers immediately, which is what the host has always done", () => {
  const s = newScheduler("off");
  const order: string[] = [];
  s.ready(1, 0, () => order.push("a"));
  s.ready(2, 0, () => order.push("b"));
  assertEquals(order.join(","), "a,b", "with scheduling off nothing is held");
  assertEquals(s.on, false);
  assertEquals(s.log.length, 0, "off records nothing; there are no choices to record");
});

Deno.test("one worker at a time: a second bridge waits until the first comes back", async () => {
  const s = newScheduler("fifo");
  const order: string[] = [];
  s.ready(1, 0, () => order.push("one"));
  s.ready(2, 0, () => order.push("two"));
  // The first is delivered; the second is held, because bridge 1 is now running.
  assertEquals(order.join(","), "one", `held nothing: ${order.join(",")}`);
  s.quiet(1);
  assertEquals(order.join(","), "one,two", "the second went out once the first came back");
  await sleep(0);
});

Deno.test("fifo is the order they became ready, whatever order they are offered in", () => {
  const s = newScheduler("fifo");
  const order: number[] = [];
  // Three ready at once: only the first goes out, and the rest in arrival order as each comes back.
  s.ready(1, 0, () => order.push(1));
  s.ready(2, 0, () => order.push(2));
  s.ready(3, 0, () => order.push(3));
  s.quiet(1);
  s.quiet(2);
  assertEquals(order.join(","), "1,2,3");
});

Deno.test("a seed makes the same choices, and a different seed makes different ones", () => {
  const run = (seed: number): string => {
    const s = newScheduler("seeded", seed);
    const order: number[] = [];
    // Six ready, released one at a time — the choice among those waiting is where the seed shows.
    for (let i = 1; i <= 6; i++) s.ready(i, 0, () => order.push(i));
    for (let i = 0; i < 6; i++) for (let b = 1; b <= 6; b++) s.quiet(b);
    return order.join(",");
  };
  assertEquals(run(1), run(1), "the same seed has to make the same choices");
  assertEquals(run(1) === run(99), false, "different seeds should explore different orderings");
  // And it is a real ordering, not a shuffle that drops or repeats work.
  assertEquals(run(1).split(",").sort().join(","), "1,2,3,4,5,6");
});

Deno.test("the log is the sequence of choices, which is what replays a run a seed cannot", () => {
  const s = newScheduler("fifo");
  s.ready(7, 2, () => {});
  s.quiet(7);
  s.ready(8, 5, () => {});
  assertEquals(s.log.length, 2, s.log.join(" "));
  assertEquals(s.log[0].startsWith("7:2@"), true, s.log[0]);
  assertEquals(s.log[1].startsWith("8:5@"), true, s.log[1]);
});

Deno.test("a worker that never comes back does not stall the rest for ever", async () => {
  // The one case with no signal: a worker that finishes without submitting again. Its result arrives
  // elsewhere, so a short hurry-up drops the mark. It cannot decide anything — the worst it does is
  // allow an ordering the policy did not choose, which is the behaviour with no scheduler at all.
  const s = newScheduler("fifo");
  const order: string[] = [];
  s.ready(1, 0, () => order.push("first"));
  s.ready(2, 0, () => order.push("second"));
  assertEquals(order.join(","), "first");
  await sleep(30);
  assertEquals(order.join(","), "first,second", "the hurry-up never released the second");
});
