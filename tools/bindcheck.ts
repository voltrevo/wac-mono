import { wacCompile } from "wac/wacCompile.ts";
import { wacBindgen } from "wac/wacBindgen.ts";
import { wacFiles } from "../harness/wacFiles.ts";
for (const entry of Deno.args) {
  const files = await wacFiles(entry);
  const r = wacCompile(files, entry);
  if (!r.ok) { console.log(`${entry}: DIAG ${r.diagnostics[0].message}`); continue; }
  const ts = wacBindgen(r.compiled);
  const classes = [...ts.matchAll(/^export class (\w+)/gm)].map(m => m[1]);
  const fns = [...ts.matchAll(/^export function (\w+)/gm)].map(m => m[1]);
  const skipped = [...ts.matchAll(/^\/\/ skipped: (.*)$/gm)].map(m => m[1]);
  console.log(`\n=== ${entry}`);
  console.log(`  classes: ${classes.join(", ") || "(none)"}`);
  console.log(`  functions: ${fns.length} — ${fns.slice(0, 8).join(", ")}${fns.length > 8 ? " …" : ""}`);
  for (const s of skipped.slice(0, 6)) console.log(`  skipped: ${s}`);
  if (skipped.length > 6) console.log(`  … and ${skipped.length - 6} more skipped`);
}
