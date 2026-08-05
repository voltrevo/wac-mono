// What a wedged test is still working on.
//
// wac-mono 0082's last section. A test that runs N cases through a pool and hangs reports the *test's*
// name and nothing else: Deno eventually says `"every script agrees with bash" has been running for over
// (4m0s)`, which is true and useless — 614 scripts went in and the one that is stuck is not named. I lost
// twenty minutes to exactly that, instrumenting the harness by hand to print each case, finding the answer
// (four `wc` cases, all of which run in 106 ms on their own), and then deleting the instrumentation. The
// next person would start from nothing.
//
// So the pool says what it is holding. Two ways in, both cheap:
//
//   - **On a wedge, unprompted.** If nothing completes for `quietMs`, the labels still in flight go to
//     standard error, and again every `quietMs` after. Nobody has to have predicted the hang.
//   - **`WAC_TRACE=1`, on purpose.** Every start and finish, for when the interesting part is the order or
//     the overlap rather than the stall.
//
// **This clock cannot fail a test.** That distinction is the whole of 0082: a deadline that decides an
// outcome turns another agent's load into a red suite, and four such clocks did. A clock that only narrates
// costs a slow machine one extra line of stderr, so the budget can be short enough to be useful without
// anybody having to tune it against contention.

/** A label still being worked on, and how long since it started. */
export type Held = { label: string; heldMs: number };

export type Flight = {
  /** Call as work starts; call the returned function when it ends. */
  start(label: string): () => void;
  /** What is in flight now, longest-held first. Exported so a test can assert on it. */
  held(): Held[];
  /** Stop narrating. Must be called — a live timer outlives the test otherwise. */
  stop(): void;
};

/** Where narration goes. Standard error, because standard output is often the thing under test. */
function say(line: string): void {
  try {
    Deno.stderr.writeSync(new TextEncoder().encode(`${line}\n`));
  } catch {
    // A closed stderr is not worth failing a test over; narration is never the point of the run.
  }
}

/**
 * Watch a pool of concurrent work.
 *
 * `what` names the units for the reader — "script", "case", "request" — and appears in every line.
 * `quietMs` is how long nothing may complete before the pool says what it is holding; the default is
 * generous enough that an ordinary slow case never speaks, and short enough to beat Deno's own four-minute
 * warning, which is the alternative source of this information and names nothing.
 */
export function watch(what: string, options: { quietMs?: number } = {}): Flight {
  const quietMs = options.quietMs ?? 45_000;
  const trace = Deno.env.get("WAC_TRACE") === "1";
  const flight = new Map<number, { label: string; at: number }>();
  let next = 0;
  let lastFinish = performance.now();
  let started = 0;
  let finished = 0;

  const held = (): Held[] => {
    const now = performance.now();
    return [...flight.values()]
      .map((e) => ({ label: e.label, heldMs: Math.round(now - e.at) }))
      .sort((a, b) => b.heldMs - a.heldMs);
  };

  // Spoken once per `quietMs` of silence — at one budget, two, three — rather than on every tick. A wedge
  // that lasts ten minutes should say so more than once, because the reader arrives partway through and
  // scrolls to the end; it should not fill the log, because the same three lines repeated a hundred times
  // are read as noise and bury the failure they were supposed to explain.
  let spoken = 0;
  const tick = setInterval(() => {
    if (flight.size === 0) return;
    const quiet = performance.now() - lastFinish;
    const budgets = Math.floor(quiet / quietMs);
    if (budgets <= spoken) return;
    spoken = budgets;
    say(
      `wac: ${what}s in flight for ${(quiet / 1000).toFixed(1)}s with none finishing ` +
        `(${finished} of ${started} done):`,
    );
    for (const e of held()) say(`wac:   ${what} held ${(e.heldMs / 1000).toFixed(1)}s: ${e.label}`);
  }, Math.max(50, Math.floor(quietMs / 4)));
  // So the interval is not itself a reason for the process to stay alive. `stop()` clears it; this covers
  // the path where a throw skips the `finally` somebody forgot to write.
  Deno.unrefTimer(tick);

  return {
    start(label: string): () => void {
      const id = next++;
      flight.set(id, { label, at: performance.now() });
      started++;
      if (trace) say(`wac: ${what} start: ${label}`);
      let ended = false;
      return () => {
        // Idempotent: a caller that ends in both a `finally` and the happy path is not a miscount.
        if (ended) return;
        ended = true;
        const entry = flight.get(id);
        flight.delete(id);
        finished++;
        lastFinish = performance.now();
        spoken = 0;
        if (trace && entry !== undefined) {
          say(`wac: ${what} done in ${Math.round(performance.now() - entry.at)}ms: ${label}`);
        }
      };
    },
    held,
    stop(): void {
      clearInterval(tick);
    },
  };
}

/**
 * Run `items` through `work` with `jobs` at a time, narrating a wedge.
 *
 * The pool is here rather than at each call site because the loop and the narration have to agree about
 * what is in flight; two copies drift and the second one stops naming anything. Results come back in the
 * order the items went in, not the order they finished.
 */
export async function pool<T, R>(
  items: readonly T[],
  jobs: number,
  work: (item: T, index: number) => Promise<R>,
  options: { what?: string; label?: (item: T, index: number) => string; quietMs?: number } = {},
): Promise<R[]> {
  const what = options.what ?? "item";
  const label = options.label ?? ((item: T) => String(item));
  const flight = watch(what, { quietMs: options.quietMs });
  const results = new Array<R>(items.length);
  let next = 0;
  try {
    const worker = async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        const done = flight.start(label(items[index], index));
        try {
          results[index] = await work(items[index], index);
        } finally {
          done();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
  } finally {
    flight.stop();
  }
  return results;
}
