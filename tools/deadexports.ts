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
// So a report from this is a question, not a verdict. The two answers are "use it at the
// call sites, which usually reads better than the literal" and "delete it".

const roots = ["packages", "harness"];

/** `export <type> name(` — the shapes wac declares a function in. */
const EXPORT = /^\s*export\s+(?:[A-Za-z_][\w]*(?:\[\])*|void|bool|i32|i64|u8|u32|u64|f32|f64)(?:\[\])*\s+([a-zA-Z_]\w*)\s*\(/;

type Decl = { name: string; file: string; line: number };

async function wacFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    try {
      for await (const e of Deno.readDir(d)) {
        const p = `${d}/${e.name}`;
        if (e.isDirectory) {
          if (e.name === "node_modules" || e.name === ".git") continue;
          await walk(p);
        } else if (e.name.endsWith(".wac")) {
          out.push(p);
        }
      }
    } catch {
      // A root that does not exist in this checkout is not an error.
    }
  };
  await walk(dir);
  return out;
}

const files: string[] = [];
for (const r of roots) files.push(...await wacFiles(r));
files.sort();

const source = new Map<string, string>();
for (const f of files) source.set(f, await Deno.readTextFile(f));

/** A file whose exports exist to be called from TypeScript, not from wac. */
const isProbe = (f: string) =>
  f.includes("/test/") || f.includes("/size/") || f.endsWith("client_entry.wac");

const decls: Decl[] = [];
for (const f of files) {
  if (isProbe(f)) continue;
  source.get(f)!.split("\n").forEach((line, i) => {
    const m = EXPORT.exec(line);
    if (m) decls.push({ name: m[1], file: f, line: i + 1 });
  });
}

/**
 * Count uses, ignoring the declaration itself and anything inside a comment.
 *
 * Comments matter here: a doc comment naming the function it documents is the normal
 * case, and counting it would hide every dead export behind its own documentation.
 *
 * **A use is not always a call.** wac's whole capability design passes functions as values —
 * `sh.external = boxRun`, `Core.of(fakeLog, fakeWarn, …)`, `gzipStream(cli.readChunk, cli.write)`
 * — and a bare name is how that is spelled. Counting only `name(` reported `boxRun` and `boxNames`
 * as dead while a shell was running sixty programs through them, which is the kind of answer that
 * gets a check like this switched off. So the name alone counts, as long as it is not immediately
 * followed by something that makes it a different thing (a `.` or a `(`-less declaration keyword).
 */
function callers(name: string, declFile: string, declLine: number): string[] {
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
    source.get(f)!.split("\n").forEach((line, i) => {
      if (f === declFile && i + 1 === declLine) return;
      const code = line.split("//")[0];
      if (!code.trim() || /^\s*\*/.test(line)) return;
      // An import naming it is not a call — a stale import is exactly as dead.
      if (/^\s*(import|export)\s*\{/.test(code) || /^\s*[\w,\s]+\}\s*from/.test(code)) return;
      // String literals out first: a name inside one is text, not a reference.
      const bare = code.replace(/"(?:\\.|[^"\\])*"/g, '""');
      if (call.test(bare) || value.test(bare)) hits.push(`${f}:${i + 1}`);
    });
  }
  return hits;
}

/** Every local name an export is imported under. */
function aliasesOf(name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b${name}\\s+as\\s+([a-zA-Z_]\\w*)`, "g");
  for (const f of files) {
    for (const m of source.get(f)!.matchAll(re)) out.push(m[1]);
  }
  return out;
}

const dead = decls
  .map((d) => ({ ...d, used: callers(d.name, d.file, d.line) }))
  .filter((d) => d.used.length === 0);

const byFile = new Map<string, Decl[]>();
for (const d of dead) {
  if (!byFile.has(d.file)) byFile.set(d.file, []);
  byFile.get(d.file)!.push(d);
}

if (!Deno.args.includes("--quiet")) {
  if (dead.length === 0) {
    console.log(`no dead exports across ${decls.length} exported functions in ${files.length} files`);
  } else {
    console.log(`${dead.length} exported function(s) that no wac code calls:\n`);
    for (const [f, ds] of [...byFile].sort()) {
      console.log(`  ${f}`);
      for (const d of ds) console.log(`    :${String(d.line).padEnd(4)} ${d.name}`);
    }
    console.log(
      "\nEach is either a name worth using at the call sites — usually clearer than the\n" +
      "literal it was written instead of — or one worth deleting. A constant no code\n" +
      "consults documents nothing and cannot be wrong in a way a test would notice.",
    );
  }
}

// Reporting only unless asked otherwise. Most of what this finds at the moment is in
// packages other people are working in, and a check that turns somebody else's tree red
// the day it lands is a check that gets deleted rather than acted on. `--strict` is there
// for whoever wants it in a pipeline once their own package is clear.
Deno.exit(dead.length === 0 || !Deno.args.includes("--strict") ? 0 : 1);
