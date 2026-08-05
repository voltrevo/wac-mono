// One suite at a time: the marker every tool that spawns `deno test` sets and checks.
//
// wac-mono 0077: a wrapper named `test.ts` was collected as a test module by the suite it launched, and
// each generation started another — seventeen deep, load 122 on a shared five-core machine, and the host
// had to be rebooted. `tools/discovery.test.ts` makes *that* cause impossible: nothing importable by the
// runner is a script. This file covers the other direction, which no filename rule can catch — a test
// that invokes one of our tools, which invokes the suite.
//
// **An environment variable, not the process tree.** The first attempt walked `/proc/<pid>/cmdline`
// upwards. It works under `-A` and is silently inert under the permissions these tools actually run with:
// Deno answers `NotCapable: Requires all access to "/proc/…/cmdline"`, the read throws, and a guard that
// cannot read anything concludes that everything is fine. An env var needs only `--allow-env`, is
// inherited by every descendant however deep, and cannot fail closed by accident.
//
// A child that deliberately clears its environment loses the marker, which is the right answer: a clean
// environment is somebody saying explicitly that this is a new context.
export const MARKER = "WAC_SUITE_RUNNING";

/** What to add to a child suite's environment. Spread it into `Deno.Command`'s `env`. */
export const SUITE_ENV: Record<string, string> = { [MARKER]: "1" };

/**
 * Stop, loudly, if a suite is already running above us.
 *
 * `what` names the tool, because the message has to tell whoever hits it which of them refused — and
 * because the fix is always the same shape: call the thing you need directly rather than the whole suite.
 */
// **Called by `runTests.ts` only, for now.** Wiring it into `mutate.ts`, `testChanged.ts` and
// `mutate/profile.ts` as a top-level call broke the suite: those are modules, something imports them,
// and a module that calls `Deno.exit` while being imported takes the importing process with it — the
// gate died after type-checking with no output at all. The fix is `import.meta.main`, and it belongs in
// a change that is verified rather than bolted onto this one.
export function refuseIfNested(what: string): void {
  if (Deno.env.get(MARKER) === undefined) return;
  console.error(
    `${what}: refusing to run the suite from inside the suite (${MARKER} is set).\n` +
      "This is wac-mono 0077's shape: something running under `deno test` has invoked a whole suite,\n" +
      "which recurses without bound. Call the thing you need directly instead.",
  );
  Deno.exit(2);
}
