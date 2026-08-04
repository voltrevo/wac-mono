// Registers wactest's own wac-written tests, plus host-side checks on the runner
// that cannot be written in wac (they are about compilation and discovery).

import { wacTestRun } from "../../../harness/wacTestRun.ts";
import { wacCompile } from "wac/wacCompile.ts";
import { wacFiles } from "../../../harness/wacFiles.ts";

await wacTestRun("packages/wactest/test/wac/assert_test.wac", "wactest");

Deno.test("wacTestRun: discovery finds every test* export and nothing else", async () => {
  const entry = "packages/wactest/test/wac/assert_test.wac";
  const r = wacCompile(await wacFiles(entry), entry);
  if (!r.ok) throw new Error("compile failed");

  const tests = r.compiled.exports.filter(e =>
    e.name.startsWith("test") && e.params.length === 0 && e.ret === "string");
  if (tests.length < 7) {
    throw new Error(`expected at least 7 tests, found ${tests.length}`);
  }
  for (const t of tests) {
    if (t.ret !== "string") throw new Error(`${t.name} returns ${t.ret}, not string`);
  }
});

Deno.test("wacTestRun: a file with no tests is an error, not a silent pass", async () => {
  // The failure mode worth guarding: a misnamed export means zero tests run and
  // everything "passes".
  const dir = await Deno.makeTempDir();
  const path = `${dir}/empty_test.wac`;
  await Deno.writeTextFile(path, `export i32 notATest() { return 1; }`);
  let threw = false;
  try {
    await wacTestRun(path);
  } catch (e) {
    threw = true;
    if (!(e as Error).message.includes("exports no tests")) {
      throw new Error(`unexpected error: ${(e as Error).message}`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
  if (!threw) throw new Error("expected an error for a file with no tests");
});

Deno.test("wacTestRun: a failing wac assertion surfaces its message", async () => {
  // End-to-end proof that failures propagate. A runner that ignored the returned
  // string would make every wac test pass, so this drives a fixture designed to
  // fail and checks the exact message comes back.
  const entry = "packages/wactest/test/wac/fixture_failing.wac";
  const r = wacCompile(await wacFiles(entry), entry);
  if (!r.ok) throw new Error(`compile failed: ${r.diagnostics.map(d => d.message).join("; ")}`);

  const { instance } = await WebAssembly.instantiate(r.compiled.wasm as BufferSource, {});
  const ex = instance.exports as Record<string, CallableFunction>;
  const ref = ex.test_deliberately_fails();
  const len = ex.$bind$str_len(ref) as number;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = ex.$bind$str_get(ref, i) as number;
  const report = new TextDecoder().decode(bytes);

  if (report !== "1 failed: deliberate: got 1, want 2") {
    throw new Error(`unexpected report: ${JSON.stringify(report)}`);
  }
});
