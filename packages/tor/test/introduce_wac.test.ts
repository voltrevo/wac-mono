// Registers the wac-side INTRODUCE2 tests: what a service recovers from a cell a client sent.
//
// The oracle is `test/data/introduce_vectors.json`, whose cells were written by tor's own
// `hs_cell_build_introduce1` (see `tools/capture-introduce.py`). An INTRODUCE2 is byte-for-byte an
// INTRODUCE1, so this repo has both ends of one format — a client builder in `hsintro.wac` and a
// service parser in `hsservice.wac` — and checking one against the other is the symmetric oracle this
// project keeps getting caught by.
//
// It caught this one too, in the act. **tor pads an INTRODUCE1 to a fixed size and our client's
// builder does not.** A parser that returned "the rest of the plaintext" as the link specifier list
// agreed perfectly with our own builder and returned two hundred bytes of padding for tor's — which
// `linkSpecifiersValid` then refuses, because it requires the list to be exactly consumed. So a
// service would have failed to build a rendezvous circuit for a cell that was perfectly good, and no
// round trip through our own code could have shown it.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

const I_COUNT = 0;
const I_CELL = 1; // a[0]=i: the cell tor built
const I_ENC_SECRET = 2; // a[0]=i: the service's curve25519 secret
const I_SUBCRED = 3; // a[0]=i
const I_AUTH_KEY = 4; // a[0]=i: what the parse should recover
const I_CLIENT_PUBLIC = 5; // a[0]=i
const I_REND_COOKIE = 6; // a[0]=i
const I_REND_ONION_KEY = 7; // a[0]=i
const I_LINK_SPECS = 8; // a[0]=i

const v = JSON.parse(
  await Deno.readTextFile(new URL("data/introduce_vectors.json", import.meta.url)),
) as {
  source: string;
  cases: {
    introAuthKey: string;
    introEncSecret: string;
    introEncKey: string;
    subcredential: string;
    clientPublic: string;
    rendCookie: string;
    rendOnionKey: string;
    linkSpecifiers: string;
    cell: string;
  }[];
};

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

if (v.cases.length < 2) throw new Error(`expected several cases, found ${v.cases.length}`);
if (!v.source.includes("hs_cell_build_introduce1")) {
  throw new Error(`the cells must come from tor's builder, not ours — source is ${v.source}`);
}
// The padding is the point of this fixture: a cell whose plaintext ended exactly at the link
// specifier list would not distinguish the two parsers. Every cell tor writes is the same padded
// size, so a case whose cell is small enough to have no padding would be a case that proves less.
for (const c of v.cases) {
  const cell = hex(c.cell);
  const specs = hex(c.linkSpecifiers);
  if (cell.length < 200) {
    throw new Error(`cell is ${cell.length} bytes — too short to carry the padding this pins`);
  }
  // Three entries — address, RSA identity, ed25519 identity — which is what a real client sends and
  // what tor's own `hs_get_extend_info_from_lspecs` requires. A one-entry list parses identically and
  // names a rendezvous point tor would decline to use, so a fixture that shrank back to one would
  // quietly stop exercising anything that acts on the result.
  if (specs[0] < 3) throw new Error("the link specifier list should carry an identity, not just an address");
}

function ref(what: number, a: Uint8Array, _b: Uint8Array): Uint8Array {
  if (what === I_COUNT) return new Uint8Array([v.cases.length]);
  const c = v.cases[a[0]];
  switch (what) {
    case I_CELL:
      return hex(c.cell);
    case I_ENC_SECRET:
      return hex(c.introEncSecret);
    case I_SUBCRED:
      return hex(c.subcredential);
    case I_AUTH_KEY:
      return hex(c.introAuthKey);
    case I_CLIENT_PUBLIC:
      return hex(c.clientPublic);
    case I_REND_COOKIE:
      return hex(c.rendCookie);
    case I_REND_ONION_KEY:
      return hex(c.rendOnionKey);
    case I_LINK_SPECS:
      return hex(c.linkSpecifiers);
    default:
      throw new Error(`unknown vector field ${what}`);
  }
}

await wacTestRun("packages/tor/test/wac/introduce_test.wac", "introduce", [ref]);
