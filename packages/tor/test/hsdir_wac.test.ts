// Registers the wac-side HSDir hash-ring tests and supplies the captured vector.
//
// `test/data/hsdir_vectors.json` comes from `tools/capture-hsdir.py` run against a live chutney
// `hs-v3-wide` network. Committed rather than produced at test time, for the reason
// `test/vendor/README.md` gives about the ntor vectors: a differential that needs a running testnet
// stops running the moment the testnet is not there, and a suite that quietly stops checking reports
// a better number for checking less.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

const V_CASE_COUNT = 0, V_CASE_META = 1, V_CASE_HSDIRS = 2, V_RELAYS = 3,
  V_SERVICE_INDEX = 4, V_CONSENSUS = 5, V_MICRODESCS = 6;

type Vectors = {
  relays: { nickname: string; ed25519: string; hsdir: boolean }[];
  consensusDocument: string;
  microdescriptors: string;
  cases: {
    blindedKey: string;
    timePeriod: number;
    periodLength: number;
    sharedRandomValue: string;
    serviceIndex: string[];
    hsdirs: { nickname: string; ed25519: string; relayIndex: string }[];
  }[];
};

const v = JSON.parse(
  await Deno.readTextFile(new URL("data/hsdir_vectors.json", import.meta.url)),
) as Vectors;

// The candidate set is the HSDir-flagged relays, not every node with an identity key: a client has
// none and a relay can be in the consensus without the flag. Getting this wrong would change the ring
// and the selection test would fail — which is the right outcome, but the filter belongs here.
const candidates = v.relays.filter((r) => r.hsdir);
if (candidates.length <= 8) {
  throw new Error(
    `only ${candidates.length} HSDir candidates for 2x4 slots — the selection test cannot ` +
      `discriminate. Recapture from a wider network (chutney networks/hs-v3-wide).`,
  );
}
if (v.cases.length === 0) throw new Error("no hash-ring cases in the vector");

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const be64 = (n: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), false);
  return b;
};

function ref(what: number, a: Uint8Array, _b: Uint8Array): Uint8Array {
  switch (what) {
    case V_CASE_COUNT:
      return new Uint8Array([v.cases.length]);
    case V_CASE_META: {
      const c = v.cases[a[0]];
      return new Uint8Array([
        ...hex(c.blindedKey),
        ...hex(c.sharedRandomValue),
        ...be64(c.timePeriod),
        ...be64(c.periodLength),
      ]);
    }
    case V_CASE_HSDIRS: {
      const c = v.cases[a[0]];
      const out = [c.hsdirs.length];
      for (const d of c.hsdirs) out.push(...hex(d.ed25519), ...hex(d.relayIndex));
      return new Uint8Array(out);
    }
    case V_RELAYS: {
      const out = [candidates.length];
      for (const r of candidates) out.push(...hex(r.ed25519));
      return new Uint8Array(out);
    }
    case V_SERVICE_INDEX: {
      const c = v.cases[a[0]];
      return new Uint8Array(c.serviceIndex.flatMap((s) => [...hex(s)]));
    }
    case V_CONSENSUS:
      return new TextEncoder().encode(v.consensusDocument);
    case V_MICRODESCS:
      return new TextEncoder().encode(v.microdescriptors);
    default:
      throw new Error(`unknown vector field ${what}`);
  }
}

await wacTestRun("packages/tor/test/wac/hsdir_test.wac", "hsdir", [ref]);
