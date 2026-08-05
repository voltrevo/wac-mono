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
// Called at the top level of `runTests.ts`, `testChanged.ts`, `mutate.ts` and `mutate/profile.ts` — the
// four things that spawn whole test runs. Each is a script whose body runs on import, so there is no
// `import.meta.main` to add: nothing imports them, and nothing should.
//
// I removed the last three of those calls for an hour, believing they had killed a gate run. They had
// not — a full suite with them restored passes 1134 tests. What that failure was is recorded in 0077;
// the guard was innocent, and the removal was me pattern-matching on the bug I had just fixed.
export function refuseIfNested(what: string): void {
  if (Deno.env.get(MARKER) === undefined) return;
  console.error(
    `${what}: refusing to run the suite from inside the suite (${MARKER} is set).\n` +
      "This is wac-mono 0077's shape: something running under `deno test` has invoked a whole suite,\n" +
      "which recurses without bound. Call the thing you need directly instead.",
  );
  Deno.exit(2);
}
