// Registers the wac-side onion-address and key-blinding tests, and supplies tor's own vector.
//
// The vector in `test/data/hs_blind_vectors.json` is committed rather than produced at test time, for
// the reason `test/vendor/README.md` gives about the ntor vectors: a differential that needs a live
// chutney network stops running the moment the network is not there, and a suite that quietly stops
// checking reports a better number for checking less. Producing it needed a running hs-v3 testnet and
// tor's control port; consuming it needs neither.
//
// It is 1 KB, so it is committed rather than cached — `harness/fixtures.ts` puts the line at roughly a
// hundred kilobytes and this is nowhere near it.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

const V_IDENTITY = 0, V_BLINDED = 1, V_ONION = 2, V_PERIOD = 3,
  V_EXAMPLE = 4, V_EXAMPLE_COUNT = 5, V_INVALID = 6, V_INVALID_COUNT = 7;

type Vectors = {
  cases: {
    onion: string;
    identityKey: string;
    blindedKey: string;
    timePeriod: number;
    periodLength: number;
  }[];
  addressExamples: string[];
  invalidExamples: string[];
};

const vectors = JSON.parse(
  await Deno.readTextFile(new URL("data/hs_blind_vectors.json", import.meta.url)),
) as Vectors;

if (vectors.cases.length !== 1) {
  throw new Error(`expected 1 blinding case, found ${vectors.cases.length}`);
}
const c = vectors.cases[0];

const enc = new TextEncoder();
const be64 = (n: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), false);
  return b;
};

function ref(what: number, a: Uint8Array, _b: Uint8Array): Uint8Array {
  switch (what) {
    case V_IDENTITY:
      return enc.encode(c.identityKey);
    case V_BLINDED:
      return enc.encode(c.blindedKey);
    case V_ONION:
      return enc.encode(c.onion);
    case V_PERIOD:
      return new Uint8Array([...be64(c.timePeriod), ...be64(c.periodLength)]);
    case V_EXAMPLE:
      return enc.encode(vectors.addressExamples[a[0]]);
    case V_EXAMPLE_COUNT:
      return new Uint8Array([vectors.addressExamples.length]);
    case V_INVALID:
      return enc.encode(vectors.invalidExamples[a[0]]);
    case V_INVALID_COUNT:
      return new Uint8Array([vectors.invalidExamples.length]);
    default:
      throw new Error(`unknown vector field ${what}`);
  }
}

await wacTestRun("packages/tor/test/wac/hsblind_test.wac", "hsblind", [ref]);
