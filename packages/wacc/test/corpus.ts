// The differential corpus every rung is compared over.
//
// One definition, because it was written out identically in lex.test.ts and
// parse.test.ts and rungs 3, 4 and 5 each want the same thing. Sorted, so a failure
// list reads the same way twice and a diff between two runs means something.
//
// Note what this does *not* do: it does not compile or type-check anything. A corpus
// entry only has to be lexable and parseable, so a file that is valid syntax and
// invalid semantics is still a useful case — arguably the more useful kind, since it
// puts the parser somewhere the working code never goes.

import { wacLex } from "wac/wacLex.ts";
import { wacParse, type WacType } from "wac/wacParse.ts";

export type Entry = [name: string, source: string];

/** Where wac's own checkout is expected, relative to this file. */
const TOUR = new URL("../../../../wac/spec/tour.wac", import.meta.url);

export type Corpus = {
  files: Entry[];
  /** Files the walk expected but could not read, with the reason. */
  skipped: { name: string; reason: string }[];
};

/**
 * Every `.wac` file in the repo, plus `wac/spec/tour.wac` from the sibling checkout.
 *
 * tour.wac is the single most valuable entry by a distance — it is written to exercise
 * every feature in the language, which no working package does — and it is also the
 * only entry that can be legitimately absent, since not everyone clones both repos.
 * Those two facts together are why it is *reported* rather than quietly dropped: this
 * used to be a bare `catch {}`, which meant a checkout without the sibling repo lost
 * the richest file in the corpus and still printed "compared 50 files" as if nothing
 * had happened. A skip is fine. A silent skip reads as coverage that was never there.
 */
export async function corpus(): Promise<Corpus> {
  const files: Entry[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for await (const entry of Deno.readDir("packages")) {
    if (!entry.isDirectory) continue;
    for (const sub of ["src", "test/wac", "bench"]) {
      const dir = `packages/${entry.name}/${sub}`;
      let names: string[];
      try {
        names = [];
        for await (const f of Deno.readDir(dir)) {
          if (f.isFile && f.name.endsWith(".wac")) names.push(f.name);
        }
      } catch {
        // Most packages have no bench/ and wacc has no test/wac/. Absent directories
        // are the normal case here, unlike an absent file, so they are not reported.
        continue;
      }
      for (const name of names.sort()) {
        files.push([`${dir}/${name}`, await Deno.readTextFile(`${dir}/${name}`)]);
      }
    }
  }

  files.sort((a, b) => a[0].localeCompare(b[0]));

  try {
    files.push(["wac/spec/tour.wac", await Deno.readTextFile(TOUR)]);
  } catch (e) {
    skipped.push({ name: "wac/spec/tour.wac", reason: (e as Error).message });
  }

  return { files, skipped };
}

/**
 * Load the corpus, sanity-check it, and print what it holds.
 *
 * The floor catches a broken walk — a cwd that is not the repo root turns the whole
 * thing into an empty list, and an empty list makes every differential test below it
 * pass. `caller` appears in the message because the same failure from two test files
 * otherwise looks like one flaky test.
 */
const PRIM_NAMES = new Set([
  "i32", "i64", "u8", "u32", "u64", "i8", "i16", "u16", "f32", "f64", "bool", "string",
]);

/**
 * Every entry, with nothing filtered out.
 *
 * There used to be a `skipGenerics` option and a `usesGenerics` predicate that asked the reference
 * parser which files to leave out — twenty-five of them by the end, including all of `packages/std`,
 * which is the most generics-dense wac in existence. Both are gone: wacc's parser reads type
 * parameters and type arguments now, so the corpus is the corpus. Issue 0003.
 */
export async function loadCorpus(caller: string): Promise<Entry[]> {
  const { files: all, skipped } = await corpus();
  const files: Entry[] = [...all];
  if (files.length < 10) {
    throw new Error(
      `${caller}: corpus is only ${files.length} files — the walk is probably wrong. ` +
      `These tests run from the repo root; check the cwd.`);
  }
  console.log(`  ${caller}: ${files.length} files`);
  for (const s of skipped) {
    console.log(`  ${caller}: SKIPPED ${s.name} — ${s.reason}`);
  }
  return files;
}
