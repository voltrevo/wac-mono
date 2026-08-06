// Every entry file in this package compiles.
//
// Not a test of behaviour — a test that the suite can see these files at all. Nothing in
// `deno task test` used to reach `size/` or `client_entry.wac`, so when a signature moved
// under them they broke and stayed broken: `deno task size` printed "did not compile" three
// times and exited 0, and `tools/mutate.ts` turned the same error into "117 invalid
// mutants". Three separate things could see it and none of them said so (issue 0022).
//
// The programs are here too. They are the files with a `main`, so a change to the platform's
// capability world lands on them first, and they are also the files that no unit test imports —
// which for the server programs is every line they have.

import { wacCompile } from "wac/wacCompile.ts";
import { wacFiles } from "../../../harness/wacFiles.ts";

const ENTRIES = [
  "packages/tor/src/app.wac",
  "packages/tor/src/socks.wac",
  "packages/tor/src/client_entry.wac",
  // The server side: a relay, a directory authority's HTTP port, and the generator that produces the
  // documents both of them serve. Added after a refactor of `relayd.wac` compiled only because it was
  // built by hand — the list above was written when `app` and `socks` were the only programs, and
  // three more had arrived under a comment claiming there were two.
  "packages/tor/src/relayd.wac",
  "packages/tor/src/dird.wac",
  "packages/tor/src/gendesc.wac",
  "packages/tor/src/network.wac",
  "packages/tor/src/genintro.wac",
  "packages/tor/src/genhsdesc.wac",
  "packages/tor/size/proto_only.wac",
  "packages/tor/size/tor_only.wac",
  "packages/tor/size/tls_only.wac",
];

for (const entry of ENTRIES) {
  Deno.test(`entry compiles: ${entry}`, async () => {
    // The compiler's own result type. A local re-declaration here would be a second copy of a shape
    // that already exists, and `tools/size.ts` had one that quietly dropped `diagnostics`.
    const result = wacCompile(await wacFiles(entry), entry);
    if (!result.ok) {
      const lines = result.diagnostics
        .map((d) => `  ${d.file}:${d.line}:${d.col} [${d.phase}] ${d.message}`);
      throw new Error(`${entry} did not compile:\n${lines.join("\n")}`);
    }
  });
}
