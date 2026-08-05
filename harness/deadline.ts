// Bounded waiting, for tests that start a process and wait for it to be ready.
//
// **Deno 2.9 has no per-test timeout at all** — not "configured too long", absent. `deno test --help`
// offers nothing and `deno.json` sets nothing. The `has been running for over (4m0s)` line is purely
// informational and Deno will keep printing it for as long as the process lives. So an `await` that
// never settles is an infinite wait for the whole suite, and `tools/push.sh` runs the suite, which
// makes it an infinite wait before anybody can push. That is issue **0036**.
//
// The readiness pattern that causes it looks like this, and there were four copies of it:
//
//     while (!seen.includes(`listening on port ${port}`)) {
//       const { value, done } = await reader.read();
//       if (done) throw new Error(`the server exited before listening: ${seen}`);
//       seen += dec.decode(value, { stream: true });
//     }
//
// It handles the server *exiting* and not the server *living without printing* — a child that starts,
// fails to bind, and sits there produces no output and no `done`, so `read()` never settles. Ports
// come from bind-then-release, and `deno task test` passes `--parallel`, so another test taking the
// port between the release and the child's bind is a real window rather than a theoretical one.
//
// ## The point is a message, not a limit
//
// A deadline that fires with `timeout` tells you nothing you did not already know. These carry what
// was being waited for and what had been seen so far, because the person reading the failure is
// looking at a CI log for a test that touched a port they cannot inspect.
//
// Deliberately generous — seconds, not milliseconds. A bound that fires on a loaded machine is one
// people raise until it is useless, and this repo's suite already competes with mutation sweeps
// (0031). The job is converting *infinite* into *finite*, not policing latency.

/** The default, in ms. Long enough that a busy machine is never the reason a test fails. */
export const READY_TIMEOUT = 30_000;

/**
 * `promise`, or a rejection naming `what` once `ms` have passed.
 *
 * `what` may be a **thunk**, and for anything that accumulates while waiting it has to be: a string
 * is built at the call, which is before any of the waiting has happened. `readUntil` passed a string
 * describing the output seen so far and every timeout said "it printed nothing", because that was
 * true at the moment the message was composed. Its own test caught it.
 *
 * The timer is cleared on both paths — an outstanding `setTimeout` keeps Deno's op counter above zero
 * and makes the test leak-detector fail a test that otherwise passed.
 */
export function withDeadline<T>(
  promise: Promise<T>,
  what: string | (() => string),
  ms = READY_TIMEOUT,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const alarm = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(
        new Error(`timed out after ${ms}ms waiting for ${typeof what === "function" ? what() : what}`),
      ),
      ms,
    );
  });
  return Promise.race([promise, alarm]).finally(() => clearTimeout(timer));
}

/**
 * Read `stream` until `marker` appears, then stop. Returns everything consumed.
 *
 * Three ways to stop, and the caller can tell them apart from the message:
 *
 *   - the marker arrives — normal;
 *   - the stream ends first — the child exited before it was ready, and its output is quoted;
 *   - the deadline passes — the child is alive and silent, which is the case the old loop could not
 *     distinguish from "not yet".
 *
 * The reader's lock is released on every path, so a caller that wants the rest of the output after a
 * successful wait still can.
 */
export async function readUntil(
  stream: ReadableStream<Uint8Array>,
  marker: string,
  what: string,
  ms = READY_TIMEOUT,
): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let seen = "";
  const quote = () => (seen.trim() === "" ? "(it printed nothing)" : `it printed:\n${seen}`);
  try {
    return await withDeadline(
      (async () => {
        while (!seen.includes(marker)) {
          const { value, done } = await reader.read();
          if (done) {
            throw new Error(`${what}: the stream ended before ${JSON.stringify(marker)}; ${quote()}`);
          }
          seen += dec.decode(value, { stream: true });
        }
        return seen;
      })(),
      () => `${what} (waiting for ${JSON.stringify(marker)}; so far ${quote()})`,
      ms,
    );
  } finally {
    // `cancel()` rather than `releaseLock()` on the timeout path: a `read()` is still outstanding
    // there, and releasing a locked reader throws, which would replace the useful error with a
    // useless one. Cancelling settles it. On the success path there is no pending read and cancel is
    // a no-op for our purposes, because the caller is done with the stream either way.
    try {
      reader.releaseLock();
    } catch {
      await reader.cancel().catch(() => {});
    }
  }
}
