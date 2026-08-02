// Run tests that are written in wac.
//
// Discovery needs nothing from the language: wacCompile returns the export names, so
// every export called `test*` returning `string` is a test. Empty return means pass;
// anything else is the failure report.
//
// Registered as regular Deno tests, one per wac test function, so wac tests and host-side
// tests appear in the same run and the same output.
//
//   await wacTestRun("packages/gzip/test/wac/huffman_test.wac");
//
// ## Tests that need something from the host
//
// A test may take parameters, and `hostArgs` supplies them. The case that matters is an
// **oracle** — an independent implementation to compare against. A differential test is
// the strongest kind this repo has, and needing one from JavaScript is the reason most
// tests here were written in TypeScript rather than in wac. wac has no import syntax and
// no mutable module-level state, so the only way in is as an argument:
//
//   export string test_sha256(fn[u8[](u8[], i32)] ref) { … }
//
//   await wacTestRun(entry, "hash", [ (bytes, bits) => nodeHash(bytes, bits) ]);
//
// Arguments are positional and every test gets the same ones, trimmed to the number it
// declares — so one file mixes oracle-taking and pure tests freely, and a pure test still
// compiles to a module with no imports at all, which is checkable on the binary.
//
// The oracle has to be **synchronous**, because a wasm call cannot await. `node:crypto`
// is synchronous where WebCrypto is not, and `Deno.Command().outputSync()` covers
// anything reachable as a subprocess; between them every oracle this repo uses is
// available. A worker plus `Atomics.wait` would make an async one look synchronous, and
// is deliberately not used: it puts something that can deadlock inside the part of the
// system whose job is to fail clearly, and the mutation runner scores a hang as a kill.

import { wacCompile } from "wac/wacCompile.ts";
import { wacBindgen } from "wac/wacBindgen.ts";
import { wacFiles } from "./wacFiles.ts";
import { checkWacVersion } from "./wacVersion.ts";

const CACHE_DIR = ".cache";
const tempName = (base: string) => `${base}.${crypto.randomUUID()}.tmp`;

/**
 * Compile a wac test file and register each `test*` export as a Deno test.
 *
 * @param entry     path to the .wac file, relative to the repo root
 * @param prefix    label prefix, defaulting to the file's stem
 * @param hostArgs  values for tests that declare parameters, passed positionally
 */
export async function wacTestRun(
  entry: string,
  prefix?: string,
  hostArgs: unknown[] = [],
): Promise<void> {
  // Before the compiler is asked to do anything, so a stale checkout says so itself
  // rather than surfacing as a parse error in whichever test used a new feature. This was
  // dropped when the runner was rewritten to go through bindgen, and the gap showed
  // immediately: a pin bump left every `.test.ts` failing with a clear message and every
  // wac test passing, which is the wrong way round for a check that exists to explain.
  checkWacVersion();
  const result = wacCompile(await wacFiles(entry), entry);
  if (!result.ok) {
    const lines = result.diagnostics.map(d =>
      `  ${d.file}:${d.line}:${d.col} [${d.phase}] ${d.message}`);
    throw new Error(`wac test file failed to compile: ${entry}\n${lines.join("\n")}`);
  }
  for (const d of result.diagnostics) {
    console.warn(`warning: ${d.file}:${d.line}:${d.col} ${d.message}`);
  }

  const tests = result.compiled.exports.filter(e =>
    e.name.startsWith("test") && e.ret === "string");

  if (tests.length === 0) {
    throw new Error(
      `${entry} exports no tests. A test is an export named test* returning string.`);
  }
  // Named rather than counted, because "expected 1 argument" without saying which test
  // wanted it sends you reading the whole file.
  const hungry = tests.find(t => t.params.length > hostArgs.length);
  if (hungry) {
    throw new Error(
      `${entry}: ${hungry.name} takes ${hungry.params.length} argument(s) and ` +
      `${hostArgs.length} were supplied. Pass them as wacTestRun's third parameter.`);
  }

  // Through bindgen rather than a bare instantiate: that is what marshals a JS function
  // into a callback the module can hold, and what turns the returned report into a string
  // without hand-rolling the accessors.
  const ts = wacBindgen(result.compiled);
  await Deno.mkdir(CACHE_DIR, { recursive: true });
  const outPath = `${CACHE_DIR}/${entry.replaceAll("/", "_")}.gen.ts`;
  const tmpPath = tempName(outPath);
  await Deno.writeTextFile(tmpPath, ts);
  await Deno.rename(tmpPath, outPath);
  const mod = await import(`${Deno.cwd()}/${outPath}`) as Record<string, unknown>;

  const label = prefix ?? entry.split("/").pop()!.replace(/\.wac$/, "");
  for (const t of tests) {
    const fn = mod[t.name] as (...a: unknown[]) => string;
    Deno.test(`${label}: ${t.name.replace(/^test_?/, "")}`, () => {
      const report = fn(...hostArgs.slice(0, t.params.length));
      if (report !== "") throw new Error(report);
    });
  }
}
