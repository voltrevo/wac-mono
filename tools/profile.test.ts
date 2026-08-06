// What the mutation runner decides to run, and the case it used to get wrong.
//
// Selection is the part of `deno task mutate` that can be *silently* wrong: over-selection costs time,
// under-selection changes verdicts. Three separate under-selections turned up on 2026-08-06 — a test path
// that was never instrumented (0090), a corpus quietly missing its richest file, and a line whose counter
// cannot move because the compiler folded the function away. The third is the one this pins, because unlike
// the others it was a *rule* rather than an accident: "the profile knows this line and no test hits it"
// was read as "no test can observe this mutant", and recorded it as unmeasurable without running anything.
//
// `planFor` is that decision as one value, so the rule can be stated in a test instead of being implied by
// three flags in a loop.

import { type Plan, planFor, type Profile } from "./mutate/profile.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

/** A profile over `lines`, where every line named is also known. */
function profileOf(lines: Record<string, string[]>, alsoKnown: string[] = []): Profile {
  const map = new Map<string, string[]>();
  for (const [k, v] of Object.entries(lines)) map.set(k, v);
  const known = new Set([...map.keys(), ...alsoKnown]);
  const home = new Map<string, string>();
  for (const tests of map.values()) for (const t of tests) home.set(t, "packages/demo/test/a.test.ts");
  return { lines: map, known, home, testFiles: [], cost: new Map() };
}

const shape = (p: Plan): string => p.kind === "narrow" ? `narrow:${p.tests.join(",")}` : p.kind;

Deno.test("a line the profile has tests for narrows to them", () => {
  const p = profileOf({ "src/a.wac:10": ["t1", "t2"], "src/a.wac:11": ["t2"] });
  assertEquals(shape(planFor(p, ["src/a.wac:10", "src/a.wac:11"])), "narrow:t1,t2");
});

Deno.test("a line the profile has never heard of widens, because it cannot say", () => {
  const p = profileOf({ "src/a.wac:10": ["t1"] });
  assertEquals(shape(planFor(p, ["src/b.wac:99"])), "widen");
});

Deno.test("one unmodelled line in a span does not discard the selection", () => {
  // A mutation spans a whole construct and the coverage build instruments branches, so interior
  // statements often carry no point. Requiring every line to be known sent 83 of 235 mutants to the full
  // scope for no reason.
  const p = profileOf({ "src/a.wac:10": ["t1"] });
  assertEquals(shape(planFor(p, ["src/a.wac:10", "src/a.wac:11"])), "narrow:t1");
});

Deno.test("a known span nothing hits is `unhit`, which the caller still runs", () => {
  // The rule that was wrong. `unhit` is not "skip": the caller runs the whole scope and only reports the
  // unhit line if the mutant *survives* it. A constant-returning accessor is folded into its call sites,
  // so its own line never executes while its value reaches every caller.
  const p = profileOf({}, ["src/a.wac:44"]);
  assertEquals(shape(planFor(p, ["src/a.wac:44"])), "unhit");
});

Deno.test("a span with an unaccounted line widens rather than claiming nothing hits it", () => {
  // The `tlsClientInit` case: an edit span need not contain the line its point sits on, so a span can
  // hold known-but-uncovered interior lines while the covered entry is outside it. Read literally that
  // says no test reaches the function, for a function every client test calls.
  const p = profileOf({}, ["src/a.wac:44"]);
  assertEquals(shape(planFor(p, ["src/a.wac:44", "src/a.wac:45"])), "widen");
});
