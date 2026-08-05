// Check that a .wac entry compiles *and* that the wasm it produces is valid.
//
// `tools/check.ts` runs the compiler's own phases, which is the fast loop for type errors.
// It is not the whole story: several wac bugs typecheck cleanly and fail at instantiation
// instead, so a green `check` can still mean a module that will not load. This runs the
// bytes past WebAssembly's own validator, which is a stricter and independent opinion.
//
// Worth reaching for when an error names a function index rather than a line — that is the
// shape of a codegen or type-index problem, and `check` will never report it. It is how
// wac/issues/0036 was pinned down.
//
//   deno run -A tools/validate.ts packages/bignum/test/probe.wac

import { wacCompile } from "wac/wacCompile.ts";
import { wacFiles } from "../harness/wacFiles.ts";

const entry = Deno.args[0];
if (!entry) {
  console.error("usage: deno run -A tools/validate.ts <entry.wac>");
  Deno.exit(2);
}

const result = wacCompile(await wacFiles(entry), entry);
for (const d of result.diagnostics) {
  console.log(`${d.severity}: ${d.file}:${d.line}:${d.col} [${d.phase}] ${d.message}`);
}
if (!result.ok) {
  console.log("FAILED to compile");
  Deno.exit(1);
}

try {
  // `.slice()` because `WebAssembly.Module` takes a `BufferSource` and TypeScript's `Uint8Array` is
  // generic over its buffer now: one backed by a `SharedArrayBuffer` is not accepted, and the compiler
  // cannot prove this one is not. The copy is a few hundred kilobytes, once, in a diagnostic tool.
  new WebAssembly.Module(result.compiled.wasm.slice());
  console.log("OK — compiles, and the wasm validates");
} catch (e) {
  console.log(`INVALID WASM: ${(e as Error).message}`);
  Deno.exit(1);
}
