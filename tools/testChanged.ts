// The tests that could plausibly have broken, for the loop where you are still editing.
//
//   deno task test:changed
//
// **This is not the gate.** `tools/push.sh` runs the whole suite and that is what decides whether a
// commit may be pushed, because "which tests could this have broken" is a guess and a full run is
// not. What this is for is the twenty times before that, where the whole suite is fifty seconds and
// the three files you care about are two.
//
// The mapping is deliberately generous rather than clever: a change anywhere under `packages/<name>`
// runs all of that package's tests, and a change to anything shared — the harness, `tools/`, the wac
// compiler pin, `deno.json` — runs everything, because a shared change can break anything. There is
// no dependency graph here and there should not be: `packages/box` imports nine other packages, and
// a wrong graph would quietly skip the test that mattered. Generous is cheap; clever is a lie that
// takes a week to notice.
//
// Changed means "against `origin/master`, plus whatever is uncommitted", so it covers the file you
// are editing right now as well as the branch you are on.

import { refuseIfNested, SUITE_ENV } from "./suiteGuard.ts";
import { exclusiveTests, laneSplit } from "../harness/testLane.ts";

refuseIfNested("deno task test:changed");


const SHARED = ["harness/", "tools/", "deno.json", "wac-version.json", "import_map.json"];

async function git(args: string[]): Promise<string[]> {
  const r = await new Deno.Command("git", { args, stdout: "piped", stderr: "null" }).output();
  if (!r.success) return [];
  return new TextDecoder().decode(r.stdout).split("\n").filter((l) => l.length > 0);
}

const changed = new Set([
  ...await git(["diff", "--name-only", "origin/master...HEAD"]),
  ...await git(["diff", "--name-only"]),
  ...await git(["diff", "--name-only", "--cached"]),
  ...await git(["ls-files", "--others", "--exclude-standard"]),
]);

if (changed.size === 0) {
  console.log("nothing changed against origin/master; nothing to run.");
  Deno.exit(0);
}

const shared = [...changed].filter((f) => SHARED.some((s) => f.startsWith(s)));
const packages = new Set<string>();
for (const f of changed) {
  const m = f.match(/^packages\/([^/]+)\//);
  if (m !== null) packages.add(m[1]);
}

// A shared change means everything, and saying so beats running four packages and looking green.
if (shared.length > 0) {
  console.log(`shared files changed (${shared.join(", ")}) — running the whole suite.`);
}
const targets = shared.length > 0 ? [] : [...packages].sort().map((p) => `packages/${p}/`);

if (shared.length === 0) {
  if (targets.length === 0) {
    console.log(
      `${changed.size} changed file(s), none of them under packages/ or shared — nothing to run.\n` +
        "  If that is wrong, the honest move is `deno task test`.",
    );
    Deno.exit(0);
  }
  console.log(`changed packages: ${[...packages].sort().join(", ")}`);
  console.log("this is not the gate — tools/push.sh still runs everything.\n");
}

const started = Date.now();
// The same lane the gate uses: a file that declared itself exclusive is not run beside four others,
// whichever entry point started it. Two entry points with different rules would mean a flake that only
// appears in the gate, which is the worst place to meet one. See `harness/testLane.ts`.
//
// **Matched by prefix, not by equality.** `targets` here are *directories* — `packages/ssh/` — and
// `deno test` discovers the files inside them. The first version of this compared a directory against a
// file path, so nothing ever matched, the lane was empty and everything ran in parallel exactly as
// before. It looked like it worked: the suite passed, and the output said nothing either way.
// `targets` is empty in whole-suite mode, and empty means *everything* — which is the second way this
// was wrong when it was written inline. `laneSplit` is the one place that decides.
const { alone } = laneSplit(targets, (await exclusiveTests()).map((e) => e.file));
const together = targets;
const r = await new Deno.Command("deno", {
  args: [
    "test",
    "--parallel",
    // Excluded from the parallel pass rather than removed from `targets`, since a target is a whole
    // directory and only some of its files are exclusive.
    ...(alone.length > 0 ? [`--ignore=${alone.join(",")}`] : []),
    "--allow-read",
    "--allow-write",
    "--allow-run",
    "--allow-net",
    "--allow-env",
    ...together,
  ],
  // The same cap `tools/runTests.ts` applies, so the two entry points do not differ in how much of
  // the machine they take. See issue 0075 for the measurement behind 4. `SUITE_ENV` marks the children so
  // that a suite started from inside this one refuses instead of recursing — wac-mono 0077.
  env: { DENO_JOBS: Deno.env.get("DENO_JOBS") ?? "4", ...SUITE_ENV },
  stdout: "inherit",
  stderr: "inherit",
}).output();

let lane = 0;
if (alone.length > 0) {
  console.log(`\n${alone.length} file(s) run alone, by their own declaration:`);
  for (const f of alone) console.log(`  ${f}`);
  const second = await new Deno.Command("deno", {
    args: ["test", "--allow-read", "--allow-write", "--allow-run", "--allow-net", "--allow-env", ...alone],
    env: { DENO_JOBS: "1", ...SUITE_ENV },
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  lane = second.code;
}

console.log(`\n${((Date.now() - started) / 1000).toFixed(1)}s`);
Deno.exit(r.code !== 0 ? r.code : lane);
