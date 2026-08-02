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
  await Deno.writeTextFile(tmpPath, withArrayHelpers(ts));
  await Deno.rename(tmpPath, outPath);

  return await import(`${Deno.cwd()}/${outPath}`);
}

/** The typed-array view and element width for each `u8[]`-style element type bindgen names. */
const ELEMS: Record<string, { view: string; size: number }> = {
  i8: { view: "Int8Array", size: 1 },
  u8: { view: "Uint8Array", size: 1 },
  i16: { view: "Int16Array", size: 2 },
  u16: { view: "Uint16Array", size: 2 },
  i32: { view: "Int32Array", size: 4 },
  u32: { view: "Uint32Array", size: 4 },
  f32: { view: "Float32Array", size: 4 },
  f64: { view: "Float64Array", size: 8 },
};

/**
 * Supply array conversion helpers that bindgen calls but does not always define.
 *
 * **This is a shim for `wac` issue 0054 and should be deleted when that is fixed.** When an array
 * appears only inside a callback signature — `fn[u8[]()]`, `fn[bool(u8[])]` — the generated
 * dispatcher calls `_arrayToWasm_u8`/`_arrayFromWasm_u8` and neither is emitted, so the first
 * callback throws `ReferenceError`. Nothing warns: `__bindgenSkipped` is empty.
 *
 * What is inserted below is not a reimplementation. The wasm side already exports every helper it
 * needs (`__bind_arr_u8_from_mem` and friends are present in exactly the modules that are missing
 * the JS), so this is the same code bindgen emits when an export's *own* parameter is an array,
 * moved to where the dispatcher can see it.
 *
 * Conditional in both directions, so it retires itself: a definition that is already there is left
 * alone, and an element type whose wasm exports are absent is left to fail loudly as before.
 */
export function withArrayHelpers(ts: string): string {
  // Per direction, not per element type. A module can well define one and not the other — bindgen
  // emits what its own exports need — and inserting a definition that is already there is a
  // `SyntaxError` at import, which takes the whole module out.
  const needed: { dir: "To" | "From"; elem: string }[] = [];
  for (const m of ts.matchAll(/_array(To|From)Wasm_([a-z0-9]+)\b/g)) {
    const dir = m[1] as "To" | "From";
    const elem = m[2];
    if (!(elem in ELEMS)) continue;
    if (ts.includes(`function _array${dir}Wasm_${elem}(`)) continue;
    if (needed.some(n => n.dir === dir && n.elem === elem)) continue;
    needed.push({ dir, elem });
  }
  if (needed.length === 0) return ts;

  // After `_exports` exists: `_mem` reads an export at module scope. The dispatchers that call
  // these are declared earlier in the file, but only *run* after instantiation, and function
  // declarations hoist.
  const anchor = "const _exports = _instance.instance.exports;";
  if (!ts.includes(anchor)) return ts;

  let block = "\n\n// --- inserted by harness/wacBind.ts: see wac issue 0054 ---\n";
  if (!ts.includes("const _mem = _exports.__bind_mem")) {
    block += `const _mem = _exports.__bind_mem as WebAssembly.Memory;\n`;
  }
  if (!ts.includes("function _memEnsure(")) {
    block += `
function _memEnsure(bytes: number): void {
  const have = (_exports.__bind_mem_ensure as CallableFunction)(bytes) as number;
  if (have < bytes) {
    throw new Error(\`wac: could not grow the transfer buffer to \${bytes} bytes\`);
  }
}
`;
  }
  for (const { dir, elem } of needed) {
    const { view, size } = ELEMS[elem];
    block += dir === "To"
      ? `
function _arrayToWasm_${elem}(js: ${view}): unknown {
  const n = js.length;
  _memEnsure(n * ${size});
  new ${view}(_mem.buffer as ArrayBuffer, 0, n).set(js);
  return (_exports.__bind_arr_${elem}_from_mem as CallableFunction)(n);
}
`
      : `
function _arrayFromWasm_${elem}(wa: unknown): ${view} {
  const n = (_exports.__bind_arr_${elem}_len as CallableFunction)(wa) as number;
  _memEnsure(n * ${size});
  (_exports.__bind_arr_${elem}_to_mem as CallableFunction)(wa);
  // slice(), not a view: the caller keeps this and the next transfer overwrites the buffer.
  return new ${view}(_mem.buffer as ArrayBuffer, 0, n).slice();
}
`;
  }
  block += "// --- end inserted ---\n";
  return ts.replace(anchor, anchor + block);
}
