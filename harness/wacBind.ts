// wacBind — compile a .wac entry file and hand back its bindgen'd JS module.
//
// Going through wacBindgen rather than wacInstance is what makes u8[] usable
// from the test side: bindgen embeds the copy-in/copy-out helpers, so an
// `u8[] gzip(u8[])` export becomes `gzip(Uint8Array): Uint8Array`. Calling the
// raw wasm export directly is not an option — a JS caller cannot build a
// WasmGC array without those helpers.
//
// The generated module is written under .cache/ and imported, because a
// bindgen'd file is a real TypeScript module, not a string to eval.
//
// The write is atomic — a uniquely named temp file, then rename — because the suite
// runs in parallel and several test files bind the same entry. Writing the final path
// directly means one worker can import what another is halfway through writing, which
// fails as a syntax error in generated code and looks like a compiler bug.

import { wacCompile } from "wac/wacCompile.ts";
import { wacBindgen } from "wac/wacBindgen.ts";
import { wacFiles } from "./wacFiles.ts";

const CACHE_DIR = ".cache";

/**
 * A name no other worker can produce.
 *
 * `Deno.pid` plus a counter is not enough: `--parallel` runs test files in isolates
 * that share a pid, and each starts its counter at zero — so two workers wrote the
 * same temp path, one renamed it, and the other's rename failed with NotFound. Only
 * visible in parallel, from a cold cache, about one run in three.
 */
const tempName = (base: string) => `${base}.${crypto.randomUUID()}.tmp`;

export async function wacBind(entry: string): Promise<Record<string, unknown>> {
  const files = await wacFiles(entry);
  const result = wacCompile(files, entry);

  if (!result.ok) {
    const lines = result.diagnostics.map(d =>
      `  ${d.file}:${d.line}:${d.col} [${d.phase}] ${d.message}`);
    throw new Error(`wac compile failed for ${entry}:\n${lines.join("\n")}`);
  }
  // Warnings do not fail the compile, but silently dropping them in a build
  // helper is how they stay unnoticed forever.
  for (const d of result.diagnostics) {
    console.warn(`warning: ${d.file}:${d.line}:${d.col} ${d.message}`);
  }

  const ts = wacBindgen(result.compiled);
  await Deno.mkdir(CACHE_DIR, { recursive: true });
  const outPath = `${CACHE_DIR}/${entry.replaceAll("/", "_")}.gen.ts`;
  const tmpPath = tempName(outPath);
  await Deno.writeTextFile(tmpPath, ts);
  await Deno.rename(tmpPath, outPath);

  return await import(`${Deno.cwd()}/${outPath}`);
}
