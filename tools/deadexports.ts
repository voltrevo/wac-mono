// Exported wac functions that nothing calls.
//
//   deno task dead            # report them, exit 0
//   deno task dead --strict  # exit 1 if there are any
//   deno task dead --quiet   # exit code only
//
// This exists because the same mistake has now been made five times in this repo, in
// asn1.wac, x509.wac, mlkem.wac, hybrid.wac and handshake.wac: a named constant is
// written and exported — `q()` returning 3329, `tagSequence()` returning 0x30 — and then
// every call site writes the literal anyway. The name documents nothing, because no code
// consults it, and it can be wrong without any test noticing.
//
// **Coverage cannot see this.** An uncalled function is not an uncovered branch; it is
// absent from the report entirely, so a package at 100% branch coverage can be full of
// them. Mutation testing does find them — each one is a mutant that survives — but only
// after a sweep that takes minutes and produces a list that has to be read. A grep-shaped
// check runs in under a second and can be part of the normal loop.
//
// ## What it will not tell you
//
// Only whether a *wac* caller exists. Two kinds of export legitimately have none:
//
//   - probe files under `test/wac/`, whose whole purpose is to be called from TypeScript
//     through `wacBind`, so they are skipped entirely
//   - compile-only entry points — `packages/*/size/` and `client_entry.wac` — which exist to
//     be fed to the compiler by `deno task size` and are never called by anything. Skipped
//     for the same reason as probes: their exports are the measurement
//   - a package's public API, if the only consumers are outside this repo — which is not
//     the case here, since every package is exercised by a probe
//
// **Named from TypeScript counts as called.** Two shapes do that without any wac naming the
// function: a by-name bridge entry (`wacTransformStream({ …, entry: "upperCase" })`) and a method on
// a bound module (`mod.scanKeys(8, 10_000)`). Both were reported dead while their tests and benches ran
// them — `packages/stream`'s two transforms are the whole package, and a check that calls the package's
// point dead is a check nobody keeps.
//
// The method shape needs a rule for *which* TypeScript to search, because `.write(` and `.done(` are
// ordinary method names and matching them everywhere would hide real dead exports. The rule is
// **locality**: TypeScript that drives a package's wac lives in that package — its `test/`, its `bench/`,
// its `cov.ts` — or in `harness/` and `tools/`, which drive everything. A same-named method in another
// package is not a caller.
//
// The rule this replaces was "any file that mentions `wacBind` or `entry:`", which missed the fourth
// false-positive shape this check has had: `packages/gzip/cov.ts` gets its module from
// `instrument()` in `harness/wacCoverage.ts` and never writes `wacBind` itself, so `inflate` — the
// entry point of the whole decompressor, driven through eighty calls in that file — was reported dead.
// Propagating "mentions wacBind" through the import graph was the other candidate and is worse: every
// test importing `buildApp` would qualify, because `packages/platform/build.ts` binds, and then every
// `.write(` in the repo counts as a call. The old rule is kept as an *additional* allowance rather than
// replaced, so this change can only remove false positives, never add one.
//
// So a report from this is a question, not a verdict. The two answers are "use it at the
// call sites, which usually reads better than the literal" and "delete it".
//
// ## A third answer: a file that says why it is exempt
//
// Sometimes neither answer is right, because the *completeness* of a set is the contract.
// `packages/wacc/src/kinds.wac` is 84 token-kind constants mirroring the declaration order of `TokenKind`
// in the reference lexer; `kBool` has no caller because a boolean literal lexes as the keyword `true`,
// and deleting it would renumber every kind after it and break the differential test that derives those
// names from the reference at run time. A check that reports it every week gets argued with every week.
//
// So a file may exempt its own exports with a line saying why:
//
//     // dead-exports: exempt — the numbering mirrors the reference lexer's union
//
// The reason is printed in the report rather than swallowed, because an exemption nobody can see is
// indistinguishable from a check that has stopped working. Two things this is deliberately not: a
// per-*name* suppression, which would accumulate one line per argument, and an inference from shape —
// "every export is `return <int>`, so it must be a table" would silently exempt the lone misplaced
// constant that this whole check was written to find.
//
// **The scan takes a root, so it can be tested.** Five of the shapes above were false positives fixed by
// editing a regex, with nothing pinning any of them: the next edit could silently bring one back, and two
// of them *did* come back in a different spelling. `tools/deadexports.test.ts` runs this over a fixture
// tree with one file per shape. That is why `scan` is a function of a directory rather than of the
// repository it happens to live in.

/** Where wac lives, and — plus `tools` — where the TypeScript that drives it lives. */
export const WAC_ROOTS = ["packages", "harness"];
export const TS_ROOTS = [...WAC_ROOTS, "tools"];

/** `export <type> name(` — the shapes wac declares a function in. */
const EXPORT = /^\s*export\s+(?:[A-Za-z_][\w]*(?:\[\])*|void|bool|i32|i64|u8|u32|u64|f32|f64)(?:\[\])*\s+([a-zA-Z_]\w*)\s*\(/;

export type Decl = { name: string; file: string; line: number };

/** What one scan found: every export, and the ones with no caller. */
export type Exemption = { file: string; reason: string };
export type Scan = { decls: Decl[]; dead: Decl[]; files: string[]; exempt: Exemption[] };

/**
 * A file's lines with strings and comments taken out, line numbering preserved.
 *
 * Three passes, and the order is the point:
 *
 *   1. **strings first**, replaced by `""` so the surrounding punctuation still reads the same. A name
 *      inside a string is text — the `#wrap` of a CSS literal is not a use of `wrap` — and doing this
 *      first also stops the `//` of a `"http://…"` from being mistaken for a comment, which would drop
 *      the rest of a real line and report something used as dead.
 *   2. **block comments**, blanked in place so that line numbers do not move. The rule this replaces was
 *      "skip a line beginning with `*`", which covers a comment's *continuation* lines and not its first:
 *      a one-line `/** orphan() returns one. *​/` above `export i32 orphan()` was read as code, so the
 *      function was hidden by its own documentation. That is the shape this whole check exists to find.
 *   3. **line comments**, to end of line.
 */
export function codeLines(text: string): string[] {
  // `[^"\\\n]` rather than `[^"\\]`: a string literal cannot span lines, and allowing it to means one
  // stray quote in a comment pairs with the next quote several lines down, eats the newlines between them
  // and shifts every line number after it. That is not a cosmetic error — the scan skips the declaration's
  // own line by number, so a shifted file counts each declaration as its own caller, and three genuinely
  // dead exports (`ftoa32`, `writeF32`, `needsEncoding`) quietly stopped being reported when I first wrote
  // this pass the other way.
  const noStrings = text.replace(/"(?:\\.|[^"\\\n])*"/g, '""');
  const noBlocks = noStrings.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlocks.split("\n").map((line) => line.split("//")[0]);
}

/**
 * Every exported wac function under `base` that nothing calls.
 *
 * `base` is a directory laid out like this repository: `packages/`, `harness/`, `tools/`. Paths in the
 * result are relative to it, so the report reads the same whether the root is the repo or a fixture.
 */
export async function scan(base = "."): Promise<Scan> {
  /** Files under `base/<root>` with the given extension, as paths relative to `base`. */
  const listing = async (roots: string[], ext: string): Promise<string[]> => {
    const out: string[] = [];
    const walk = async (rel: string) => {
      try {
        for await (const e of Deno.readDir(`${base}/${rel}`)) {
          const p = `${rel}/${e.name}`;
          if (e.isDirectory) {
            if (e.name === "node_modules" || e.name === ".git" || e.name === ".cache") continue;
            await walk(p);
          } else if (e.name.endsWith(ext)) {
            out.push(p);
          }
        }
      } catch {
        // A root that does not exist in this checkout is not an error.
      }
    };
    for (const r of roots) await walk(r);
    out.sort();
    return out;
  };

  const files = await listing(WAC_ROOTS, ".wac");
  const source = new Map<string, string>();
  const code = new Map<string, string[]>();
  for (const f of files) {
    const text = await Deno.readTextFile(`${base}/${f}`);
    source.set(f, text);
    code.set(f, codeLines(text));
  }

  /**
   * The repo's TypeScript, for the two by-name bridges — see the header.
   *
   * Read once rather than per name: there are a hundred and forty test files and fifty-five candidates,
   * and the naive shape is a hundred and forty reads each.
   */
  const tsSource = new Map<string, string>();
  for (const f of await listing(TS_ROOTS, ".ts")) {
    tsSource.set(f, await Deno.readTextFile(`${base}/${f}`));
  }

  /** A file whose exports exist to be called from TypeScript, not from wac. */
  const isProbe = (f: string) =>
    f.includes("/test/") || f.includes("/size/") || f.endsWith("client_entry.wac");

  /** A file that exempts its own exports, and the reason it gives. */
  const EXEMPT = /\/\/\s*dead-exports:\s*exempt\s*(?:[—-]\s*)?(.*)$/m;
  const exempt: Exemption[] = [];

  const decls: Decl[] = [];
  for (const f of files) {
    if (isProbe(f)) continue;
    const claim = EXEMPT.exec(source.get(f)!);
    if (claim !== null) {
      exempt.push({ file: f, reason: claim[1].trim() });
      continue;
    }
    source.get(f)!.split("\n").forEach((line, i) => {
      const m = EXPORT.exec(line);
      if (m) decls.push({ name: m[1], file: f, line: i + 1 });
    });
  }

  /** `packages/<name>/…` → `<name>`; anything else (harness, tools) → null. */
  const packageOf = (path: string): string | null => {
    const m = /^packages\/([^/]+)\//.exec(path);
    return m === null ? m : m[1];
  };

  /** Every local name an export is imported under. */
  const aliasesOf = (name: string): string[] => {
    const out: string[] = [];
    const re = new RegExp(`\\b${name}\\s+as\\s+([a-zA-Z_]\\w*)`, "g");
    for (const f of files) {
      for (const m of source.get(f)!.matchAll(re)) out.push(m[1]);
    }
    return out;
  };

  /**
   * TypeScript that names this export as a string, or reaches it on a bound module.
   *
   * `entry: "name"` counts from anywhere — a string that spells the export is unambiguous. The method
   * shape needs somewhere to look, and the answer is the package the export is declared in, plus
   * `harness/` and `tools/` which drive every package. See the header for why the previous rule — any
   * file mentioning `wacBind` — was not enough, and why widening it through the import graph is worse
   * than narrowing it by locality.
   */
  const namedFromTypeScript = (name: string, declFile: string): string[] => {
    const hits: string[] = [];
    const asEntry = new RegExp(`entry:\\s*["']${name}["']`);
    // `.name` rather than `.name(`, for the same reason the wac side counts a bare name: a bound module's
    // function is often taken as a value first — `const inflate = inf.mod.inflate as (d: Uint8Array) =>
    // Uint8Array` — and then called under that local name. Requiring the paren reported `inflate` dead
    // while `packages/gzip/cov.ts` drove eighty calls through it. Safe to widen because the search is
    // already confined to the declaring package plus `harness/` and `tools/`.
    const asMethod = new RegExp(`\\.${name}\\b`);
    const home = packageOf(declFile);
    for (const [f, text] of tsSource) {
      if (asEntry.test(text)) {
        hits.push(f);
        continue;
      }
      const pkg = packageOf(f);
      // Local to the export's own package, or repo-wide tooling. The `wacBind`/`entry:` mention is kept
      // beside it so that cross-package driving — a test in one package binding another's module — still
      // counts, which is what this rule used to be.
      const local = pkg === null || pkg === home;
      if ((local || text.includes("wacBind") || text.includes("entry:")) && asMethod.test(text)) {
        hits.push(f);
      }
    }
    return hits;
  };

  /**
   * Count uses, ignoring the declaration itself and anything inside a comment.
   *
   * Comments matter here: a doc comment naming the function it documents is the normal
   * case, and counting it would hide every dead export behind its own documentation. `codeLines` above
   * is what takes them out, and the order it does it in is load-bearing.
   *
   * **A use is not always a call.** wac's whole capability design passes functions as values —
   * `sh.external = boxRun`, `Core.of(fakeLog, fakeWarn, …)`, `gzipStream(cli.readChunk, cli.write)`
   * — and a bare name is how that is spelled. Counting only `name(` reported `boxRun` and `boxNames`
   * as dead while a shell was running sixty programs through them, which is the kind of answer that
   * gets a check like this switched off. So the name alone counts, as long as it is not immediately
   * followed by something that makes it a different thing (a `.` or a `(`-less declaration keyword).
   */
  const callers = (name: string, declFile: string, declLine: number): string[] => {
    const hits: string[] = [];
    // `import { x as y }` means the call site says `y(`, so the alias counts as a call of
    // the original. Missing this reports every aliased import as dead, which is how a
    // check like this earns the reputation that gets it switched off.
    const names = new Set([name, ...aliasesOf(name)]);
    const any = [...names].join("|");
    const call = new RegExp(`(?<![\\w.])(?:${any})\\s*\\(`);
    // A value use: what stands before it is an `=`, a `,`, an opening bracket, a `?`/`:` of a
    // ternary, or `return`. That is narrow on purpose. Accepting a bare name *anywhere* counted the
    // local `i32 masked = …` in `bitwriter.wac` as a use of the exported `masked`, and the `#wrap` of
    // a CSS string as a use of `wrap` — trading eight false positives for false negatives, which is
    // the worse direction for a check whose whole job is to find things nothing uses.
    //
    // One false negative survives on purpose, because removing it needs name resolution rather than
    // a regex: a *local* of the same name, used as a value, counts. `bitwriter.wac` has
    // `i32 masked = …; this.bitBuf |= masked << …`, which hides the exported `masked` elsewhere. So
    // this number is a floor, not a census — trust the names it prints, and do not trust that the
    // list is complete.
    const value = new RegExp(`(?:[=,(\\[?:]|\\breturn)\\s*(?:${any})(?![\\w(])`);
    for (const f of files) {
      code.get(f)!.forEach((bare, i) => {
        if (f === declFile && i + 1 === declLine) return;
        if (!bare.trim()) return;
        // An import naming it is not a call — a stale import is exactly as dead.
        if (/^\s*(import|export)\s*\{/.test(bare) || /^\s*[\w,\s]+\}\s*from/.test(bare)) return;
        if (call.test(bare) || value.test(bare)) hits.push(`${f}:${i + 1}`);
      });
    }
    return hits;
  };

  const dead = decls.filter((d) =>
    callers(d.name, d.file, d.line).length === 0 && namedFromTypeScript(d.name, d.file).length === 0
  );
  return { decls, dead, files, exempt };
}

/** The report, as the command line prints it. Returned rather than printed so a test can read it. */
export function report(scan: Scan): string {
  // Printed in both cases, and before the verdict, so that "no dead exports" can never be a scan that
  // exempted everything. An exemption nobody sees is the same thing as a check nobody runs.
  const notes = scan.exempt.length === 0 ? "" : `${scan.exempt.length} file(s) exempt by their own note:\n` +
    scan.exempt.map((e) => `  ${e.file} — ${e.reason === "" ? "no reason given" : e.reason}`).join("\n") +
    "\n\n";
  if (scan.dead.length === 0) {
    return notes +
      `no dead exports across ${scan.decls.length} exported functions in ${scan.files.length} files`;
  }
  const byFile = new Map<string, Decl[]>();
  for (const d of scan.dead) {
    if (!byFile.has(d.file)) byFile.set(d.file, []);
    byFile.get(d.file)!.push(d);
  }
  const lines = [notes + `${scan.dead.length} exported function(s) that no wac code calls:\n`];
  for (const [f, ds] of [...byFile].sort()) {
    lines.push(`  ${f}`);
    for (const d of ds) lines.push(`    :${String(d.line).padEnd(4)} ${d.name}`);
  }
  lines.push(
    "\nEach is either a name worth using at the call sites — usually clearer than the\n" +
    "literal it was written instead of — or one worth deleting. A constant no code\n" +
    "consults documents nothing and cannot be wrong in a way a test would notice.",
  );
  return lines.join("\n");
}

if (import.meta.main) {
  const found = await scan(".");
  if (!Deno.args.includes("--quiet")) console.log(report(found));
  // Reporting only unless asked otherwise. Most of what this finds at the moment is in
  // packages other people are working in, and a check that turns somebody else's tree red
  // the day it lands is a check that gets deleted rather than acted on. `--strict` is there
  // for whoever wants it in a pipeline once their own package is clear.
  Deno.exit(found.dead.length === 0 || !Deno.args.includes("--strict") ? 0 : 1);
}
