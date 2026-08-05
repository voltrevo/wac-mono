// One port allocator for the tests that start a server.
//
// wac-mono 0069: five copies of this were in the tree, each the same five lines —
//
//     const l = Deno.listen({ port: 0 });
//     const n = (l.addr as Deno.NetAddr).port;
//     l.close();
//     return n;
//
// — and each with the same hole. Between the `close()` and the child's `bind()`, anything on the machine
// can take that port. `deno task test` runs test *files* in parallel, so several of these open the window
// at once and the race is real rather than theoretical: a full suite at five workers failed with
// `AddrInUse: Address already in use (os error 98)` from `packages/box`, which is what ended up capping
// the worker count in 0075. The ceiling on parallelism here was this bug.
//
// **Hold the port until the last moment.** That is the whole idea. A held listener is authoritative:
// while this process holds it, no other process's probe can succeed, so the port cannot be handed out
// twice anywhere on the machine. The caller releases it immediately before the child binds, which
// narrows the window from "however long the test takes to get organised" to one `spawn` call.
//
//     const held = holdPort();
//     const args = [...whatever, String(held.port)];
//     held.release();                      // ...and now nothing else can get in first
//     const child = new Deno.Command(bin, { args }).spawn();
//
// `withPort` wraps that and retries on `AddrInUse`, so the residual window costs a second attempt
// rather than a red suite.
//
// **What was tried first and was worse.** The first version of this partitioned the ephemeral range by
// `Deno.pid % slices`, on the theory that two workers would draw from different slices. With a 1024-wide
// slice that is fifteen slices for five workers, and two pids collide mod 15 more than half the time —
// which the allocator's own test then found, at five workers, by failing. Holding removes the need to
// guess: the kernel already knows who has what, and a held listener is how you ask it.
//
// **Not every `port: 0` is a race.** `packages/platform`'s `aliasing`, `listen` and `timeout` tests bind a
// listener and *accept on it* — they never release it, so nothing can take it, and they are left alone.
// The racy shape is specifically probe, close, hand the number to a child.
//
// The registered range (1024–49151) is deliberately avoided: it is where things like sshd, a chutney
// testnet or a stray httpd live on this machine, and colliding with one of those is not a race but a
// misunderstanding.

/** The ephemeral range this picks from, above anything a service on this machine is likely to hold. */
const LOW = 49152;
const HIGH = 65535;

/** Ports this process has handed out, so it cannot hand one out twice even after a release. */
const handed = new Set<number>();

/** A port this process is holding: nobody else can take it until `release` is called. */
export type Held = {
  port: number;
  /** Close the listener. Call it immediately before whatever is going to bind the port. */
  release(): void;
};

/**
 * Take a port and hold it.
 *
 * Starts from a random point in the ephemeral range rather than a pid-derived one: a random start
 * spreads concurrent callers without pretending to partition anything, and the holding is what actually
 * prevents a collision.
 */
export function holdPort(): Held {
  const span = HIGH - LOW + 1;
  const start = LOW + Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const port = LOW + ((start - LOW + i) % span);
    if (handed.has(port)) continue;
    try {
      const listener = Deno.listen({ hostname: "127.0.0.1", port });
      handed.add(port);
      let closed = false;
      return {
        port,
        release: () => {
          // Idempotent: a caller that releases in a `finally` as well as before the spawn is being
          // careful, not wrong.
          if (closed) return;
          closed = true;
          listener.close();
        },
      };
    } catch {
      // Held by somebody else, or a service. Try the next.
    }
  }
  throw new Error(
    `no free port in ${LOW}..${HIGH} (pid ${Deno.pid}, ${handed.size} already taken here). ` +
      `Either the machine is out of ephemeral ports or something is holding the range.`,
  );
}

/**
 * A port nothing is listening on, released before it is returned.
 *
 * For callers that cannot hold — where the port has to be a plain number long before anything binds it.
 * The window is the same one this file exists to shrink, so prefer `holdPort` or `withPort`; this is
 * kept because two call sites genuinely need the number early, and a helper that forces them to lie
 * about their shape is worse than one that names the cost.
 */
export function freePort(): number {
  const held = holdPort();
  held.release();
  return held.port;
}

/**
 * Run `start` with a held port, released just before `start` is called, retrying on `AddrInUse`.
 *
 * `start` should throw if the server could not bind — a child exiting with "Address already in use" on
 * its stderr amounts to that, so a caller checking for those words and throwing is using this correctly.
 *
 * Anything that is *not* a bind failure is rethrown immediately: retrying a test that failed for a real
 * reason turns one clear failure into three slow ones.
 */
export async function withPort<T>(start: (port: number) => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const held = holdPort();
    held.release();
    try {
      return await start(held.port);
    } catch (e) {
      if (!isAddrInUse(e)) throw e;
      last = e;
      console.error(
        `port ${held.port} was taken between the release and the bind; retrying (${attempt}/${attempts})`,
      );
    }
  }
  throw last;
}

/** Whether a failure is the race rather than a real one. Deno's typed error, or a child's own words. */
export function isAddrInUse(e: unknown): boolean {
  if (e instanceof Deno.errors.AddrInUse) return true;
  const text = e instanceof Error ? e.message : String(e);
  return /AddrInUse|Address already in use|EADDRINUSE/i.test(text);
}
