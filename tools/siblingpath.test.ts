// A path that walks out of this repo has to go through the import map.
//
// Twice now, the same mistake: `new URL("../../../../wac/spec/tour.wac", import.meta.url)` — correct in a
// side-by-side checkout and wrong everywhere else. `deno.json` maps `wac/` to the sibling checkout, and
// `tools/mutate.ts` stages `packages` and `harness` into a temp directory *and rewrites that mapping to an
// absolute path* so the staged copy can still find the compiler. A hand-counted `../..` ignores the map and
// points at `/tmp/…/wac`, which does not exist.
//
// What makes it worth a check rather than a comment is how differently the two failed.
// `packages/wacc/test/lex.test.ts` threw, the sweep reported `BASELINE RED: packages/wacc`, and somebody
// fixed it that day. `packages/wacc/test/corpus.ts` *caught* the read failure and printed a SKIPPED line
// from a test that then passed — so every mutation run for weeks measured a corpus missing `tour.wac`, the
// one file written to exercise every feature in the language, and reported the mutants only it reaches as
// surviving. The same bug is found where it is loud and survives where it is quiet.
//
// So: `import.meta.resolve("wac/…")` asks the map. This fails a `new URL(…, import.meta.url)` that resolves
// above the repository root.

import { codeLines } from "./deadexports.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

const ROOTS = ["packages", "harness", "tools"];

/** Every `.ts` file under the roots, as repo-relative paths. */
async function sources(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    for await (const e of Deno.readDir(rel)) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory) {
        if (e.name === "node_modules" || e.name === ".git" || e.name === ".cache") continue;
        await walk(p);
      } else if (e.name.endsWith(".ts")) {
        out.push(p);
      }
    }
  };
  for (const r of ROOTS) await walk(r);
  return out.sort();
}

/** `new URL("<rel>", import.meta.url)` — the shape both bugs took. */
const RELATIVE_URL = /new URL\(\s*"((?:[^"\\\n]|\\.)*)"\s*,\s*import\.meta\.url\s*\)/g;

Deno.test("no file reaches out of the repository by counting `..`", async () => {
  const root = await Deno.realPath(".");
  const offenders: string[] = [];
  for (const file of await sources()) {
    // Comments stripped first, reusing the dead-export check's pass: this file's own header quotes the
    // wrong form as an example, and a check that its own explanation fails is a check that gets deleted.
    const text = codeLines(await Deno.readTextFile(file)).join("\n");
    for (const m of text.matchAll(RELATIVE_URL)) {
      const target = new URL(m[1], `file://${root}/${file}`).pathname;
      if (!target.startsWith(`${root}/`)) {
        offenders.push(`  ${file}\n    new URL(${JSON.stringify(m[1])}, import.meta.url) → ${target}`);
      }
    }
  }
  assertEquals(
    offenders.length,
    0,
    "a path that leaves the repository must be resolved through the import map — " +
      "`import.meta.resolve(\"wac/…\")` — because a mutation run stages this tree somewhere else and " +
      "rewrites the map to match:\n" + offenders.join("\n"),
  );
});

Deno.test("the check would catch the shape it was written for", () => {
  // The rule is a regex over source, so the thing worth pinning is that the regex matches the exact line
  // that was wrong, and that resolution — not the number of `..` — is what decides.
  const sample = `const TOUR = new URL("../../../../wac/spec/tour.wac", import.meta.url);`;
  const found = [...sample.matchAll(RELATIVE_URL)].map((m) => m[1]);
  assertEquals(found.join(","), "../../../../wac/spec/tour.wac");

  const root = "/repo";
  const from = `file://${root}/packages/wacc/test/corpus.ts`;
  assertEquals(new URL(found[0], from).pathname.startsWith(`${root}/`), false, "this one escapes");
  // And a path that stays inside is not an offender, however many `..` it has.
  assertEquals(
    new URL("../../../harness/appRun.ts", from).pathname.startsWith(`${root}/`),
    true,
    "three levels up from packages/wacc/test is still inside the repo",
  );
});
