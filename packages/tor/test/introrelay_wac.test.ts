// Registers the wac-side introduction-point tests for the **relay**.
//
// Two captured fixtures, both cells C tor built: the ESTABLISH_INTRO from `estintro_vectors.json`
// with the circuit nonce it was MACed against, and an INTRODUCE1 from `introduce_vectors.json` for a
// different service entirely. The second matters — the relay must refuse to route a cell for a key it
// does not hold, and a fixture whose two cells shared an auth key could not show that.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

const R_ESTABLISH_CELL = 0;
const R_KH = 1;
const R_AUTH_PUBLIC = 2;
const R_INTRODUCE_CELL = 3;
const R_INTRODUCE_AUTH = 4;

const est = JSON.parse(
  await Deno.readTextFile(new URL("data/estintro_vectors.json", import.meta.url)),
) as { authPublic: string; circuitKH: string; cell: string };

const intro = JSON.parse(
  await Deno.readTextFile(new URL("data/introduce_vectors.json", import.meta.url)),
) as { source: string; cases: { introAuthKey: string; cell: string }[] };

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

if (!intro.source.includes("hs_cell_build_introduce1")) {
  throw new Error(`the INTRODUCE1 must come from tor's builder — source is ${intro.source}`);
}
// The two cells must be for *different* services, or "a key we do not hold" is untestable.
if (est.authPublic === intro.cases[0].introAuthKey) {
  throw new Error("the two fixtures share an auth key; the unknown-id case would prove nothing");
}

function ref(what: number, _a: Uint8Array, _b: Uint8Array): Uint8Array {
  switch (what) {
    case R_ESTABLISH_CELL:
      return hex(est.cell);
    case R_KH:
      return hex(est.circuitKH);
    case R_AUTH_PUBLIC:
      return hex(est.authPublic);
    case R_INTRODUCE_CELL:
      return hex(intro.cases[0].cell);
    case R_INTRODUCE_AUTH:
      return hex(intro.cases[0].introAuthKey);
    default:
      throw new Error(`unknown vector field ${what}`);
  }
}

await wacTestRun("packages/tor/test/wac/introrelay_test.wac", "introrelay", [ref]);
