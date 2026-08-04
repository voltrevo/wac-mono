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
//
// The result is cached by the content of everything that produced it — see `buildCache.ts`. A hit
// skips the compiler entirely, which is most of what this repo's suite used to spend its time on:
// twenty test files bind the same handful of entries, and each one compiled the whole import graph
// again. Profile mode never caches, because it wants the compiler's coverage table rather than only
// its output.

import { wacCompile } from "wac/wacCompile.ts";
import { wacBindgen } from "wac/wacBindgen.ts";
import { wacFiles } from "./wacFiles.ts";
import { checkWacVersion } from "./wacVersion.ts";
import { profileDir, registerProfiled } from "./wacProfile.ts";
import { cached, compilerKeyParts, contentKey, filesParts, harnessKeyParts } from "./buildCache.ts";

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

/**
 * The cache key for a binding, or null when it cannot be computed.
 *
 * Null means "do not cache", which is the honest answer when the compiler's own sources cannot be
 * read: that is the case where a stale artifact does the most damage, since whoever is editing the
 * compiler would be shown their previous build and told their fix did nothing.
 */
async function bindKey(entry: string, files: Map<string, string>): Promise<string | null> {
  const compiler = await compilerKeyParts();
  const harness = await harnessKeyParts();
  if (compiler === null || harness === null) return null;
  return await contentKey(["bind", entry, ...compiler, ...harness, ...filesParts(files)]);
}

/** Compile and bind, throwing with the diagnostics a person needs. Shared by both paths. */
function generate(files: Map<string, string>, entry: string): string {
  const result = wacCompile(files, entry);
  if (!result.ok) {
    const lines = result.diagnostics.map((d) =>
      `  ${d.file}:${d.line}:${d.col} [${d.phase}] ${d.message}`);
    throw new Error(`wac compile failed for ${entry}:\n${lines.join("\n")}`);
  }
  for (const d of result.diagnostics) {
    console.warn(`warning: ${d.file}:${d.line}:${d.col} ${d.message}`);
  }
  return wacBindgen(result.compiled);
}

export async function wacBind(entry: string): Promise<Record<string, unknown>> {
  // Before the compiler is asked to do anything, so a stale checkout says so itself
  // rather than surfacing as a type error in whichever package used a new feature.
  checkWacVersion();
  const files = await wacFiles(entry);

  // The fast path: this exact program, compiled by this exact compiler, is already on disk.
  if (!profileDir) {
    const key = await bindKey(entry, files);
    if (key !== null) {
      const path = await cached("bind", key, ".gen.ts", async (tmp) => {
        await Deno.writeTextFile(tmp, generate(files, entry));
      });
      return await import(`${Deno.cwd()}/${path}`) as Record<string, unknown>;
    }
  }

  // Profile mode compiles with coverage instrumentation so wacProfile can record which
  // tests reach which lines. Off by default and invisible to a normal run: the
  // instrumented build is a different binary, and it is used for attribution only, never
  // for deciding whether a mutant was killed.
  const result = wacCompile(files, entry, profileDir ? { coverage: true } : {});

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
  const outPath = `${CACHE_DIR}/${profileDir ? "prof_" : ""}${entry.replaceAll("/", "_")}.gen.ts`;
  const tmpPath = tempName(outPath);
  await Deno.writeTextFile(tmpPath, ts);
  await Deno.rename(tmpPath, outPath);

  const mod = await import(`${Deno.cwd()}/${outPath}`) as Record<string, unknown>;
  if (profileDir) {
    // The counter array is allocated by __cov_init, not at instantiation; without it the
    // first instrumented branch traps on a null pointer.
    (mod.__cov_init as () => void)();
    const points = result.compiled.coverage!;
    registerProfiled({
      points,
      counts: () => {
        const len = (mod.__cov_len as () => number)();
        const get = mod.__cov_get as (i: number) => number;
        return Array.from({ length: len }, (_, i) => get(i));
      },
    });
  }
  return mod;
}
