// Type-check a .wac entry and print diagnostics. Faster loop than a full test.
import { wacCompile } from "wac/wacCompile.ts";
import { wacFiles } from "../harness/wacFiles.ts";

const entry = Deno.args[0];
const result = wacCompile(await wacFiles(entry), entry);
for (const d of result.diagnostics) {
  console.log(`${d.severity}: ${d.file}:${d.line}:${d.col} [${d.phase}] ${d.message}`);
}
console.log(result.ok ? "OK" : "FAILED");
if (!result.ok) Deno.exit(1);
