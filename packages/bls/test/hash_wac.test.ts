// hash_to_field, against the CFRG draft's own vectors.
//
// The first stage with a genuinely external oracle: `test/vendor/hash_to_G2.json` is the draft's
// published corpus, and each vector carries the intermediate `u` values as well as the final
// point. So this file checks `hash_to_field` alone — if it passes and the map fails later, the
// bug is in the map, which is the localisation the whole staged arrangement is for.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/bls/test/wac/probe.wac") as unknown as {
  blsExpandMessage(msg: Uint8Array, dst: Uint8Array, len: number): Uint8Array;
  blsHashToField(msg: Uint8Array, dst: Uint8Array): Uint8Array;
};

type Suite = {
  dst: string;
  L: string;
  vectors: { msg: string; u: string[]; P: { x: string; y: string }; Q0: unknown; Q1: unknown }[];
};
const suite: Suite = JSON.parse(
  await Deno.readTextFile(new URL("vendor/hash_to_G2.json", import.meta.url)),
);
const enc = new TextEncoder();
const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

/** The draft writes Fp2 as "c0,c1" with 0x prefixes. */
const fp2Hex = (s: string) =>
  s.split(",").map((h) => h.trim().replace(/^0x/, "").padStart(96, "0")).join("");

Deno.test("hash_to_field matches every CFRG vector", () => {
  const dst = enc.encode(suite.dst);
  for (const v of suite.vectors) {
    const got = hex(mod.blsHashToField(enc.encode(v.msg), dst));
    const want = v.u.map(fp2Hex).join("");
    if (got !== want) {
      throw new Error(
        `msg ${JSON.stringify(v.msg)}\n  got  ${got.slice(0, 64)}…\n  want ${want.slice(0, 64)}…`,
      );
    }
  }
});

Deno.test("expand_message_xmd refuses what the RFC puts out of range", () => {
  const dst = enc.encode(suite.dst);
  // A DST over 255 bytes, and a length needing more than 255 blocks, are both defined as errors
  // rather than as something to truncate — truncating silently would weaken domain separation.
  if (mod.blsExpandMessage(new Uint8Array(0), new Uint8Array(256), 32).length !== 0) {
    throw new Error("a 256-byte DST was accepted");
  }
  if (mod.blsExpandMessage(new Uint8Array(0), dst, 255 * 32 + 1).length !== 0) {
    throw new Error("an over-long expansion was accepted");
  }
  if (mod.blsExpandMessage(new Uint8Array(0), dst, 0).length !== 0) {
    throw new Error("a zero-length expansion was accepted");
  }
  // And a length that is not a multiple of the hash size is truncated to exactly that length.
  if (mod.blsExpandMessage(new Uint8Array(0), dst, 37).length !== 37) {
    throw new Error("a 37-byte expansion came back the wrong length");
  }
});
