// Run tests that are written in wac.
//
// Discovery needs nothing from the language: wacCompile returns the export names,
// so every no-argument export called `test*` returning `string` is a test. Empty
// return means pass; anything else is the failure report.
//
// Registered as regular Deno tests, one per wac test function, so wac tests and
// host-side tests appear in the same run and the same output.
//
//   await wacTestRun("packages/gzip/test/wac/huffman_test.wac");

import { wacCompile } from "wac/wacCompile.ts";
import { wacFiles } from "./wacFiles.ts";

/**
 * Compile a wac test file and register each `test*` export as a Deno test.
 *
 * @param entry  path to the .wac file, relative to the repo root
 * @param prefix label prefix, defaulting to the file's stem
 */
export async function wacTestRun(entry: string, prefix?: string): Promise<void> {
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
    e.name.startsWith("test") && e.params.length === 0 && e.ret === "string");

  if (tests.length === 0) {
    throw new Error(
      `${entry} exports no tests. A test is a no-argument export named test* ` +
      `returning string.`);
  }

  // Strings cross the boundary as wasm refs, so the bindgen string helpers are
  // needed to read a failure report back out. Rather than generating a module,
  // decode it directly from the same helpers bindgen would use.
  const { instance } = await WebAssembly.instantiate(result.compiled.wasm as BufferSource, {});
  const ex = instance.exports as Record<string, CallableFunction>;

  const readString = (ref: unknown): string => {
    const len = ex.__bind_str_len(ref) as number;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = ex.__bind_str_get(ref, i) as number;
    return new TextDecoder().decode(bytes);
  };

  const label = prefix ?? entry.split("/").pop()!.replace(/\.wac$/, "");
  for (const t of tests) {
    Deno.test(`${label}: ${t.name.replace(/^test_?/, "")}`, () => {
      const report = readString(ex[t.name]());
      if (report !== "") throw new Error(report);
    });
  }
}
