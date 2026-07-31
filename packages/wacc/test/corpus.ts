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
/**
 * Does this file use generics?
 *
 * Asked of the *reference* parser rather than of the text, because a regex over `<` finds
 * every comparison in the repo. wacc's parser does not implement type parameters yet
 * (issue 0003), so the rungs that parse skip these and say so; the lexer is unaffected,
 * since `<` and `>` were always ordinary tokens.
 */
export function usesGenerics(source: string): boolean {
  const { program } = wacParse(wacLex(source).tokens, source);
  let found = false;
  const inType = (t: WacType): void => {
    if (found) return;
    switch (t.kind) {
      case "struct":
        if (t.typeArgs !== undefined && t.typeArgs.length > 0) { found = true; return; }
        return;
      case "array":    return inType(t.elem);
      case "nullable": return inType(t.inner);
      case "funcref":  t.params.forEach(inType); return inType(t.ret);
      default: return;
    }
  };
  for (const item of program.items) {
    if (item.tag === "import") continue;
    if (item.tag !== "const" && item.typeParams.length > 0) return true;
    // A file may *use* a generic without declaring one — every consumer of `std` does — and
    // the parser has to read `Vec<i32>` in a type position to get through it.
    if (item.tag === "func") { inType(item.returnType); item.params.forEach((p) => inType(p.type)); }
    else if (item.tag === "struct") { item.fields.forEach((f) => inType(f.type)); }
    else if (item.tag === "enum") {
      item.variants.forEach((v) => v.fields.forEach((f) => inType(f.type)));
    } else if (item.tag === "const") inType(item.type);
    if (found) return true;
  }
  // A generic used only inside a body — `Vec<i32> v = Vec.create();` in a function — is the
  // common case and the declaration walk above does not reach it, so fall back to the tokens:
  // an `ident <` pair that a comparison could not be, because a type is what follows.
  const { tokens } = wacLex(source);
  for (let i = 0; i + 2 < tokens.length; i++) {
    if (tokens[i].kind !== "ident" || tokens[i + 1].kind !== "<") continue;
    const after = tokens[i + 2].kind;
    if (after !== "ident" && !PRIM_NAMES.has(after)) continue;
    // `a < b > c` is legal arithmetic; a type argument list is followed by an identifier,
    // `?`, `[`, `(` or `>`-then-identifier. Requiring the closer to be adjacent to a name
    // keeps this from claiming comparisons.
    for (let j = i + 2; j < tokens.length && j < i + 12; j++) {
      const k = tokens[j].kind;
      if (k === ">" || k === ">>") {
        const next = tokens[j + 1]?.kind;
        if (next === "ident" || next === "?" || next === "[" || next === ".") return true;
        break;
      }
      if (k !== "ident" && k !== "," && k !== "[" && k !== "]" && k !== "?" &&
          !PRIM_NAMES.has(k)) break;
    }
  }
  return false;
}

const PRIM_NAMES = new Set([
  "i32", "i64", "u8", "u32", "u64", "i8", "i16", "u16", "f32", "f64", "bool", "string",
]);

export async function loadCorpus(
  caller: string,
  opts: { skipGenerics?: boolean } = {},
): Promise<Entry[]> {
  const { files: all, skipped } = await corpus();
  const files: Entry[] = [];
  for (const [name, source] of all) {
    if (opts.skipGenerics === true && usesGenerics(source)) {
      skipped.push({ name, reason: "uses generics, which wacc's parser does not implement (issue 0003)" });
      continue;
    }
    files.push([name, source]);
  }
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
