// Branch coverage for bytes.
//
// Driven from the package's own wac tests, which are the thing that exercises Buf
// directly. tools/coverage.ts also reports on this file, but only the branches gzip
// happens to reach — which is why it shows 67.7% for a type with twelve test cases.
//
//   deno task coverage:bytes
//   deno task coverage:bytes --verbose

import { instrument, report } from "../../harness/wacCoverage.ts";

const verbose = Deno.args.includes("--verbose");

const run = await instrument("packages/bytes/test/wac/buf_test.wac");
for (const [name, fn] of Object.entries(run.mod)) {
  if (!name.startsWith("test") || typeof fn !== "function") continue;
  const failure = (fn as () => string)();
  if (failure !== "") throw new Error(`${name} failed during coverage: ${failure}`);
}

/**
 * The bounds fixture is a second entry point.
 *
 * A trap unwinds to the host and leaves the instance usable, so the counters survive
 * — which is what lets a trapping branch be counted as covered at all.
 */
const bounds = await instrument("packages/bytes/test/bounds.wac");
for (
  const name of [
    "getPastEnd", "getNegative", "getAtCapacityNotLength", "getOk",
    // pushRepeat refusing a source that is not there: before the start, and past the length.
    "pushRepeatBeforeStart", "pushRepeatPastEnd", "pushRepeatNegativeCount",
  ]
) {
  try { (bounds.mod[name] as () => number)(); } catch { /* the trap is the point */ }
}

report([run, bounds], "packages/bytes/", { verbose });
