// Registers the wac-side router status tests.
//
// The vector pairs, for five relays, the descriptor C tor published with the `r` line C tor's
// authority wrote about it — both taken from a chutney network's own files. Every field of an `r` line
// is derivable from the descriptor, so reproducing the line from the document is a differential against
// their implementation with none of ours on the other side.
//
// See `tools/capture-votestatus.py` for how they are paired, and for why the pairing is itself the
// interesting part: the `r` line's digest is not a hash of the whole descriptor, and with the obvious
// span none of the five paired at all.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

const V_COUNT = 0;
const V_DESCRIPTOR = 1; // a[0]=i
const V_R_LINE = 2; // a[0]=i: the line tor's authority wrote
// The parsed fields, from the capture tool's own parse rather than by splitting the line here. The
// publication time contains a space, so "the nth space-separated field" is not a well-defined notion
// for this line — splitting on spaces made field 4 the date alone, and cost a wrong test.
const V_PUBLICATION = 3; // a[0]=i
const V_DIGEST = 4; // a[0]=i
const V_ADDRESS = 5; // a[0]=i
const V_ORPORT = 6; // a[0]=i
const V_DIRPORT = 7; // a[0]=i

const v = JSON.parse(
  await Deno.readTextFile(new URL("data/votestatus_vectors.json", import.meta.url)),
) as {
  cases: {
    nickname: string;
    identity: string;
    digest: string;
    publication: string;
    address: string;
    orPort: number;
    dirPort: number;
    rLine: string;
    descriptor: string;
  }[];
};

if (v.cases.length < 3) throw new Error(`expected several relays, found ${v.cases.length}`);

const enc = (s: string) => new TextEncoder().encode(s);

function ref(what: number, a: Uint8Array, _b: Uint8Array): Uint8Array {
  switch (what) {
    case V_COUNT:
      return new Uint8Array([v.cases.length]);
    case V_DESCRIPTOR:
      return enc(v.cases[a[0]].descriptor);
    case V_R_LINE:
      return enc(v.cases[a[0]].rLine);
    case V_PUBLICATION:
      return enc(v.cases[a[0]].publication);
    case V_DIGEST:
      return enc(v.cases[a[0]].digest);
    case V_ADDRESS:
      return enc(v.cases[a[0]].address);
    case V_ORPORT:
      return enc(String(v.cases[a[0]].orPort));
    case V_DIRPORT:
      return enc(String(v.cases[a[0]].dirPort));
    default:
      throw new Error(`unknown vector field ${what}`);
  }
}

await wacTestRun("packages/tor/test/wac/votestatus_test.wac", "votestatus", [ref]);
