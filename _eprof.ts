import { wacCompile } from "wac/wacCompile.ts";
import { wacBindgen } from "wac/wacBindgen.ts";
import { wacFiles } from "./harness/wacFiles.ts";
import { corpus } from "./packages/zstd/bench/corpus.ts";

const entry = "packages/zstd/src/encode.wac";
const r = wacCompile(await wacFiles(entry), entry, { coverage: true });
if (!r.ok) { console.log(r.diagnostics.slice(0,3)); Deno.exit(1); }
await Deno.writeTextFile(".cache/_eprof.gen.ts", wacBindgen(r.compiled));
const mod = await import(`${Deno.cwd()}/.cache/_eprof.gen.ts`) as any;
const items = await corpus();
const pts = r.compiled.coverage!;

for (const name of ["json", "wac source"]) {
  const s = items.find(x => x.name === name)!;
  mod.__cov_init();
  mod.compress(s.data);
  const rows = pts.map((p: any, i: number) => ({ ...p, n: mod.__cov_get(i) }))
    .filter((p: any) => p.n > 0).sort((a: any, b: any) => b.n - a.n);
  const per = (n: number) => (n / s.data.length).toFixed(2);
  console.log(`\n=== ${name}: ${s.data.length} bytes  (count, per input byte)`);
  for (const p of rows.slice(0, 10)) {
    console.log(String(p.n).padStart(11), per(p.n).padStart(8), p.kind.padEnd(8), `${p.file.split("/").pop()}:${p.line}`);
  }
}
