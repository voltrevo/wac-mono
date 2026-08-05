// Registers the wac-side descriptor tests and supplies the captured descriptor.
//
// `test/data/hsdesc_vectors.json` is a real v3 descriptor fetched by a tor client, plus keys and
// plaintext digests derived by `tools/capture-descriptor.py` with `hashlib` and `openssl enc` —
// never through this implementation. The capture verifies both layer MACs before writing, so a
// descriptor captured wrong cannot become an expected value.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

const V_DESCRIPTOR = 0, V_KEYS = 1, V_LAYER = 2, V_INTRO_COUNT = 3, V_INTRO = 4;

type Vectors = {
  identityKey: string;
  blindedKey: string;
  descriptorSigningKey: string;
  subcredential: string;
  revisionCounter: number;
  descriptor: string;
  layers: {
    name: string;
    salt: string;
    secretKey: string;
    secretIv: string;
    macKey: string;
    plaintextSha3: string;
    plaintextLength: number;
  }[];
  introductionPoints: { linkSpecifiers: string; onionKeyNtor: string; encKeyNtor: string; authKey: string }[];
};

const v = JSON.parse(
  await Deno.readTextFile(new URL("data/hsdesc_vectors.json", import.meta.url)),
) as Vectors;

if (v.layers.length !== 2) throw new Error(`expected two layers, found ${v.layers.length}`);
if (v.introductionPoints.length === 0) throw new Error("the vector has no introduction points");

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const be64 = (n: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), false);
  return b;
};
// latin-1 rather than UTF-8: the descriptor is base64 and keywords, so the two agree — but the
// decrypted plaintexts are compared by hash over raw bytes, and a stray multi-byte encoding here
// would shift every offset in a way that is tedious to find later.
const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

function ref(what: number, a: Uint8Array, _b: Uint8Array): Uint8Array {
  switch (what) {
    case V_DESCRIPTOR:
      return bytes(v.descriptor);
    case V_KEYS:
      return new Uint8Array([
        ...hex(v.identityKey),
        ...hex(v.blindedKey),
        ...hex(v.descriptorSigningKey),
        ...hex(v.subcredential),
        ...be64(v.revisionCounter),
      ]);
    case V_LAYER: {
      const l = v.layers[a[0]];
      return new Uint8Array([
        ...hex(l.salt),
        ...hex(l.secretKey),
        ...hex(l.secretIv),
        ...hex(l.macKey),
        ...hex(l.plaintextSha3),
        ...be64(l.plaintextLength),
      ]);
    }
    case V_INTRO_COUNT:
      return new Uint8Array([v.introductionPoints.length]);
    case V_INTRO: {
      const p = v.introductionPoints[a[0]];
      const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
      const ls = b64(p.linkSpecifiers);
      return new Uint8Array([
        ls.length >> 8, ls.length & 0xff, ...ls,
        ...b64(p.onionKeyNtor), ...b64(p.encKeyNtor), ...hex(p.authKey),
      ]);
    }
    default:
      throw new Error(`unknown vector field ${what}`);
  }
}

await wacTestRun("packages/tor/test/wac/hsdesc_test.wac", "hsdesc", [ref]);
