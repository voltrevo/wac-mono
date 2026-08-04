// The literal operator's shape sampling, on inputs small enough to count by hand.
//
// This is worth a test rather than a measurement because the failure mode is silent and one-sided:
// if the classification is too coarse the sweep quietly stops asking real questions, and the only
// symptom is a *better* number. That is the same shape as the baseline bug the tool's own header
// warns about — a red suite scoring every mutant as killed and reporting a perfect result.
//
// The measured per-file effects are in `issues/closed/0027-…`; these are the invariants.

import { generate, type GenerateStats } from "./mutate/operators.ts";

const stats = (): GenerateStats => ({ literalSampled: 0, literalSkipped: 0, shapes: 0 });
const literals = (src: string, perShape?: number) => {
  const st = stats();
  const ms = generate("packages/x/src/y.wac", src, ["literal"], st, perShape);
  return { count: ms.length, names: ms.map((m) => m.name), st };
};

Deno.test("a long constant table yields three mutants, not one per entry", () => {
  const table = Array.from({ length: 200 }, (_, i) => i * 3).join(", ");
  const { count, st } = literals(`const i32[] T = i32[](${table});\n`);
  // Three for the interior class, plus the few entries near `(` and `)` whose token neighbourhood
  // genuinely differs. Far fewer than 200 is the property; the exact boundary count is not.
  if (count > 12) throw new Error(`expected a handful of mutants, got ${count}`);
  if (count < 3) throw new Error(`expected at least three mutants, got ${count}`);
  if (st.literalSkipped < 180) throw new Error(`expected most entries skipped, skipped ${st.literalSkipped}`);
});

Deno.test("the three samples are spread through the table, not the first three", () => {
  // Distinct values so a mutant name identifies which entry it came from.
  const table = Array.from({ length: 300 }, (_, i) => 1000 + i).join(", ");
  const { names } = literals(`const i32[] T = i32[](${table});\n`);
  const picked = names
    .map((n) => /\/(\d+)→/.exec(n)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
  if (picked.length < 3) throw new Error(`expected at least three values, got ${picked.join(",")}`);
  const span = picked[picked.length - 1] - picked[0];
  // Sampling the first three would give a span of 2. Anything near the table's full width is fine.
  if (span < 200) {
    throw new Error(
      `samples span only ${span} of a 300-entry table — they are clustered, not spread: ${picked.join(",")}`,
    );
  }
});

Deno.test("distinct statements are distinct shapes, so ordinary logic is not sampled away", () => {
  // Seven literals in seven different syntactic neighbourhoods: none is a repeat of another, so
  // every one must still be mutated. This is the half of the rule that keeps the sweep useful.
  const src = `i32 f(i32 n) {
  if (n < 7) { return 3; }
  i32 a = n * 5;
  i32 b = a >> 2;
  while (b > 11) { b = b - 4; }
  return b;
}
`;
  const { st } = literals(src);
  if (st.literalSkipped !== 0) {
    throw new Error(`sampled away ${st.literalSkipped} literal(s) from code that repeats nothing`);
  }
});

Deno.test("each function's table is its own class, so none is left untested", () => {
  // FIVE tables, deliberately more than the three samples a single class would get. Two would not
  // discriminate: with three samples spread first/middle/last across two lumped tables, both
  // happen to get one anyway, and the test passes with the scoping broken. It has to be possible
  // for a table to receive nothing before "every table receives something" means anything.
  const words = (base: number) =>
    Array.from({ length: 12 }, (_, i) => `  v[${i}] = ${base + i};`).join("\n");
  const fn = (n: number, base: number) =>
    `u32[] f${n}() {\n  u32[] v = u32[12]();\n${words(base)}\n  return v;\n}\n`;
  const bases = [1000, 2000, 3000, 4000, 5000];
  const { names } = literals(bases.map((b, i) => fn(i, b)).join("\n"));
  const values = names
    .map((n) => Number(/\/(\d+)→/.exec(n)?.[1]))
    .filter((v) => Number.isFinite(v));
  const missing = bases.filter((b) => !values.some((v) => v >= b && v < b + 12));
  if (missing.length > 0) {
    throw new Error(
      `tables at ${missing.join(", ")} got no mutant — their classes were merged with another's`,
    );
  }
});

Deno.test("each module-level const table is its own class, so none is left untested", () => {
  // The case that was wrong in the first version: everything at module level shared one scope, so
  // six separate tables in unicode/src/tables.wac became a single class of 8758 members and got
  // three samples for the lot. Five tables here for the same reason as above — with two, spread
  // sampling covers both by accident and the test cannot see the fault.
  const run = (base: number) => Array.from({ length: 60 }, (_, i) => base + i).join(", ");
  const bases = [1000, 2000, 3000, 4000, 5000];
  const src = bases.map((b, i) => `const i32[] T${i} = i32[](${run(b)});`).join("\n") + "\n";
  const { names } = literals(src);
  const values = names
    .map((n) => Number(/\/(\d+)→/.exec(n)?.[1]))
    .filter((v) => Number.isFinite(v));
  const missing = bases.filter((b) => !values.some((v) => v >= b && v < b + 60));
  if (missing.length > 0) {
    throw new Error(
      `module-level tables at ${missing.join(", ")} got no mutant — scoped by declaration, each ` +
        `should contribute its own samples`,
    );
  }
});

Deno.test("--no-sample generates one mutant per literal", () => {
  const table = Array.from({ length: 200 }, (_, i) => i * 3).join(", ");
  const src = `const i32[] T = i32[](${table});\n`;
  const all = literals(src, Number.POSITIVE_INFINITY);
  if (all.count !== 200) throw new Error(`expected 200 mutants unsampled, got ${all.count}`);
  if (all.st.literalSkipped !== 0) throw new Error(`--no-sample skipped ${all.st.literalSkipped}`);
  // And sampling must be purely subtractive: every sampled mutant is one the full run also emits.
  const sampled = new Set(literals(src).names);
  const full = new Set(all.names);
  for (const n of sampled) {
    if (!full.has(n)) throw new Error(`sampling invented a mutant the full run does not emit: ${n}`);
  }
});
