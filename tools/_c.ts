import { wacCompile } from "wac/wacCompile.ts";
import { wacFiles } from "../harness/wacFiles.ts";
const r = wacCompile(await wacFiles(Deno.args[0]), Deno.args[0], {}) as unknown as Record<string, unknown>;
if (!r.ok) for (const d of (r.diagnostics as {file:string;line:number;col:number;message:string}[]).slice(0,6)) console.log(`  ${d.file}:${d.line}:${d.col} ${d.message}`);
else console.log("ok");
