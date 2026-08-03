#!/usr/bin/env -S deno run -A
// Write bindgen's TypeScript for a wac entry, so it can be type-checked.
//
//   deno task bindgen packages/json/src/json.wac /tmp/json.gen.ts
//   deno check /tmp/json.gen.ts
//
// `tools/bindcheck.ts` summarises what bindgen produced — which classes, which functions, what it
// skipped. This writes the file instead, which is the only way to ask the question that matters for
// a *generated* module: does it compile?
//
// It exists because four open bugs on the wac repo (#4, #5, #6, #7) are all invalid generated
// TypeScript — a struct field named `ref`, an export named `_exports`, a parameter named `_w_x`, a
// struct named `Box_i32` beside a `Box<i32>` — and none of them can be seen from a built
// application. `deno bundle` strips types without checking them, so `deno task app:build` is happy
// and the artifact runs; the collision only surfaces when somebody imports the bindings into a
// TypeScript project, which is what bindgen is *for*.

import { wacCompile } from "wac/wacCompile.ts";
import { wacBindgen } from "wac/wacBindgen.ts";
import { wacFiles } from "../harness/wacFiles.ts";

if (Deno.args.length !== 2) {
  console.error("usage: deno task bindgen <entry.wac> <out.gen.ts>");
  Deno.exit(2);
}
const [entry, out] = Deno.args;
const files = await wacFiles(entry);
const r = wacCompile(files, entry);
if (!r.ok) {
  console.error(`${entry}: ${r.diagnostics[0].message}`);
  Deno.exit(1);
}
await Deno.writeTextFile(out, wacBindgen(r.compiled));
console.log(`${out}  ${(await Deno.stat(out)).size} bytes`);
