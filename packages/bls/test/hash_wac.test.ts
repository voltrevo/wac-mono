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

// ── map_to_curve ──────────────────────────────────────────────────────────────

const mapMod = mod as unknown as {
  blsMapToCurve(uc0: Uint8Array, uc1: Uint8Array): Uint8Array;
  blsMapLandsOnCurve(uc0: Uint8Array, uc1: Uint8Array): boolean;
};
const bytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
/** One coefficient of a draft "c0,c1" pair. */
const coeff = (s: string, i: number) =>
  bytes(s.split(",")[i].trim().replace(/^0x/, "").padStart(96, "0"));

Deno.test("map_to_curve matches Q0 and Q1 in every CFRG vector", () => {
  // The second checkpoint. `Q0` and `Q1` are the map's output *before* the cofactor is cleared,
  // so a wrong isogeny coefficient fails here and a wrong cofactor clearing does not — which is
  // what makes a failure mean something specific rather than "hash_to_G2 is wrong".
  type Pt = { x: string; y: string };
  for (const v of suite.vectors) {
    for (const [name, q] of [["Q0", (v as unknown as { Q0: Pt }).Q0],
                             ["Q1", (v as unknown as { Q1: Pt }).Q1]] as [string, Pt][]) {
      const i = name === "Q0" ? 0 : 1;
      const got = mapMod.blsMapToCurve(coeff(v.u[i], 0), coeff(v.u[i], 1));
      if (got.length === 0) throw new Error(`${name} for ${JSON.stringify(v.msg)}: map refused`);
      const gotHex = Array.from(got).map((x) => x.toString(16).padStart(2, "0")).join("");
      const want = [0, 1].map((k) => coeff(q.x, k)).concat([0, 1].map((k) => coeff(q.y, k)))
        .map((b) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("")).join("");
      if (gotHex !== want) {
        throw new Error(`${name} for ${JSON.stringify(v.msg)}\n  got  ${gotHex.slice(0, 64)}…\n  want ${want.slice(0, 64)}…`);
      }
    }
  }
});

Deno.test("the map's output is on the real curve, not the isogenous one", () => {
  // If the isogeny were skipped or wrong the point would satisfy E' rather than E, and every
  // later step would still run.
  for (const v of suite.vectors) {
    for (const u of v.u) {
      if (!mapMod.blsMapLandsOnCurve(coeff(u, 0), coeff(u, 1))) {
        throw new Error(`map_to_curve left the curve for ${JSON.stringify(v.msg)}`);
      }
    }
  }
});

// ── hash_to_G2, end to end ────────────────────────────────────────────────────

const h2Mod = mod as unknown as {
  blsHashToG2(msg: Uint8Array, dst: Uint8Array): Uint8Array;
  blsHashToG2InSubgroup(msg: Uint8Array, dst: Uint8Array): boolean;
};

Deno.test("hash_to_G2 matches P in every CFRG vector", () => {
  // The third and last checkpoint of this stage. With `u` and `Q0`/`Q1` already passing, a
  // failure here can only be the addition or the cofactor clearing.
  const dst = enc.encode(suite.dst);
  for (const v of suite.vectors) {
    const got = Array.from(h2Mod.blsHashToG2(enc.encode(v.msg), dst))
      .map((x) => x.toString(16).padStart(2, "0")).join("");
    const want = [0, 1].map((k) => coeff(v.P.x, k))
      .concat([0, 1].map((k) => coeff(v.P.y, k)))
      .map((b) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("")).join("");
    if (got !== want) {
      throw new Error(`msg ${JSON.stringify(v.msg)}\n  got  ${got.slice(0, 64)}…\n  want ${want.slice(0, 64)}…`);
    }
  }
});

Deno.test("hash_to_G2 lands in the order-r subgroup", () => {
  // Which is the entire purpose of clearing the cofactor, and is not implied by the vectors
  // above: a point could match P and still be checked wrongly by `g2InSubgroup`.
  const dst = enc.encode(suite.dst);
  for (const v of suite.vectors) {
    if (!h2Mod.blsHashToG2InSubgroup(enc.encode(v.msg), dst)) {
      throw new Error(`hash_to_G2(${JSON.stringify(v.msg)}) is outside the subgroup`);
    }
  }
});

Deno.test("hash_to_G2 matches the Ethereum fixtures too", async () => {
  // A second corpus for the same function. Their generator uses the draft's DST — checked by
  // reading `main.py` rather than by trying both — so these add messages rather than a new
  // configuration. Worth having for one of them in particular: a 517-byte message, which is the
  // only case here that drives `expand_message_xmd` past a single output block.
  const eth: Record<string, { input: { msg: string }; output: { x: string; y: string } }> =
    JSON.parse(await Deno.readTextFile(new URL("vendor/eth_hash_to_G2.json", import.meta.url)));
  const dst = enc.encode("QUUX-V01-CS02-with-BLS12381G2_XMD:SHA-256_SSWU_RO_");
  for (const [name, c] of Object.entries(eth)) {
    const got = Array.from(h2Mod.blsHashToG2(enc.encode(c.input.msg), dst))
      .map((x) => x.toString(16).padStart(2, "0")).join("");
    const want = [0, 1].map((k) => coeff(c.output.x, k))
      .concat([0, 1].map((k) => coeff(c.output.y, k)))
      .map((b) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("")).join("");
    if (got !== want) throw new Error(`${name}\n  got  ${got.slice(0, 64)}…\n  want ${want.slice(0, 64)}…`);
  }
});
