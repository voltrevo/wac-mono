// Branch coverage for std.
//
// Three entry points, because the tests are split three ways and each compiles its own
// module: the containers, the sum types, and the trap fixture. The last one matters more
// here than elsewhere — every bounds check in Vec is a branch that only a trapping call
// reaches, and a trap unwinds to the host leaving the instance usable, so the counters
// survive it.
//
//   deno task coverage:std
//   deno task coverage:std --verbose

import { instrument, report } from "../../harness/wacCoverage.ts";

const verbose = Deno.args.includes("--verbose");

const runs = [];
for (const entry of [
  "packages/std/test/wac/vec_test.wac",
  "packages/std/test/wac/map_test.wac",
  "packages/std/test/wac/option_test.wac",
]) {
  const run = await instrument(entry);
  for (const [name, fn] of Object.entries(run.mod)) {
    if (!name.startsWith("test") || typeof fn !== "function") continue;
    const failure = (fn as () => string)();
    if (failure !== "") throw new Error(`${name} failed during coverage: ${failure}`);
  }
  runs.push(run);
}

const traps = await instrument("packages/std/test/traps.wac");
for (const fn of Object.values(traps.mod)) {
  if (typeof fn !== "function") continue;
  try { (fn as () => number)(); } catch { /* the trap is the point */ }
}
runs.push(traps);

report(runs, "packages/std/", { verbose });
