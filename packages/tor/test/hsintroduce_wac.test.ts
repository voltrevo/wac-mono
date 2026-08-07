// Registers the wac-side test for answering one INTRODUCE2.
//
// Same fixture as `introduce_wac.test.ts` — cells C tor built with `hs_cell_build_introduce1` — used
// for a different question. That file checks the parse; this one checks the *order* the parse sits
// in, which is where tor puts its two replay caches and its rendezvous-point validation, and which no
// amount of testing the pieces can establish.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

const I_COUNT = 0;
const I_CELL = 1;
const I_ENC_SECRET = 2;
const I_SUBCRED = 3;
const I_AUTH_KEY = 4;
const I_COOKIE = 5;

const v = JSON.parse(
  await Deno.readTextFile(new URL("data/introduce_vectors.json", import.meta.url)),
) as {
  source: string;
  cases: {
    introAuthKey: string;
    introEncSecret: string;
    subcredential: string;
    rendCookie: string;
    linkSpecifiers: string;
    cell: string;
  }[];
};

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

if (!v.source.includes("hs_cell_build_introduce1")) {
  throw new Error(`the cells must come from tor's builder, not ours — source is ${v.source}`);
}
// The rendezvous point in these cells is a loopback address, because they come from chutney. The
// happy path here therefore runs with private addresses allowed, and the refusal is checked too —
// so a fixture that ever stopped naming a private address would silently turn one of those cases
// into a duplicate of the other.
for (const c of v.cases) {
  const ls = hex(c.linkSpecifiers);
  let at = 1, sawPrivate = false;
  for (let i = 0; i < ls[0]; i++) {
    const type = ls[at], len = ls[at + 1];
    if (type === 0 && len === 6 && (ls[at + 2] === 127 || ls[at + 2] === 10)) sawPrivate = true;
    at += 2 + len;
  }
  if (!sawPrivate) {
    throw new Error("a cell no longer names a private rendezvous point; the allowPrivate cases now prove less");
  }
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
    case I_COOKIE:
      return hex(c.rendCookie);
    default:
      throw new Error(`unknown vector field ${what}`);
  }
}

await wacTestRun("packages/tor/test/wac/hsintroduce_test.wac", "hsintroduce", [ref]);
