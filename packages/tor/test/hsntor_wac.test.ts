// Registers the wac-side hs-ntor tests and supplies tor's own answers.
//
// `test/data/hsntor_vectors.json` comes from `tools/capture-hsntor.py`, which drives tor's
// `src/test/test-hs-ntor-cl`. Committed rather than shelled out at test time, for the reason
// `test/vendor/README.md` records about the ntor vectors: the binary lived in /tmp once, vanished
// with the container, and turned the shared suite red for three agents who had not touched it.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

const V_COUNT = 0, V_CASE = 1;

type Case = {
  introAuthKey: string;
  introEncKey: string;
  introEncSecret: string;
  clientEphemeralSecret: string;
  clientEphemeralPublic: string;
  serviceEphemeralPublic: string;
  subcredential: string;
  encKey: string;
  macKey: string;
  authMac: string;
  ntorKeySeed: string;
};

const v = JSON.parse(
  await Deno.readTextFile(new URL("data/hsntor_vectors.json", import.meta.url)),
) as { cases: Case[] };

if (v.cases.length < 3) throw new Error(`expected several hs-ntor cases, found ${v.cases.length}`);

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

function ref(what: number, a: Uint8Array, _b: Uint8Array): Uint8Array {
  if (what === V_COUNT) return new Uint8Array([v.cases.length]);
  if (what === V_CASE) {
    const c = v.cases[a[0]];
    // Fixed 32-byte fields in a fixed order; the wac side slices by offset.
    const parts = [
      c.introAuthKey, c.introEncKey, c.clientEphemeralSecret, c.clientEphemeralPublic,
      c.serviceEphemeralPublic, c.subcredential, c.encKey, c.macKey, c.authMac, c.ntorKeySeed,
      // The service's own secret, appended rather than inserted so the offsets above do not move.
      c.introEncSecret,
    ];
    for (const p of parts) {
      if (p.length !== 64) throw new Error(`field is ${p.length / 2} bytes, expected 32: ${p}`);
    }
    return new Uint8Array(parts.flatMap((p) => [...hex(p)]));
  }
  throw new Error(`unknown vector field ${what}`);
}

await wacTestRun("packages/tor/test/wac/hsntor_test.wac", "hsntor", [ref]);
