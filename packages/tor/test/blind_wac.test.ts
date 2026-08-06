// Registers the wac-side key-blinding tests for the **service** half.
//
// The oracle is `test/data/blind_vectors.json`, from tor's own `ed25519_keypair_blind` — see
// `tools/capture-blind.py`. `hsblind_wac.test.ts` already pins the blinded *public* key, which is
// what a client derives; this is the blinded *secret*, which only a service uses, to sign the
// descriptor's signing-key certificate.
//
// **Why it needs its own oracle, and why no descriptor test can stand in.** Nothing in a descriptor
// says which key signed it: tor verifies the certificate against the key carried inside that
// certificate. So a wrong blinded secret produces a descriptor that decodes perfectly for anyone who
// does not know the identity key — `hsdesc-probe.c` accepts one — and fails only for the clients who
// matter, because only they compute the blinded key independently and expect it to match.
//
// The captured signature matters as much as the key. A scalar that is wrong by a factor of the
// cofactor still looks like a scalar and still produces 64 plausible bytes; only signing with it and
// verifying against the blinded public key tells the two apart.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

const B_COUNT = 0;
const B_SEED = 1; // a[0]=i
const B_FACTOR = 2;
const B_IDENTITY_SECRET = 3;
const B_IDENTITY_PUBLIC = 4;
const B_BLINDED_SECRET = 5;
const B_BLINDED_PUBLIC = 6;
const B_SIGNATURE = 7;
const B_MESSAGE = 8;

const v = JSON.parse(
  await Deno.readTextFile(new URL("data/blind_vectors.json", import.meta.url)),
) as {
  source: string;
  cases: {
    seed: string;
    factor: string;
    identitySecret: string;
    identityPublic: string;
    blindedSecret: string;
    blindedPublic: string;
    signature: string;
    message: string;
  }[];
};

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const utf8 = (s: string) => new TextEncoder().encode(s);

if (v.cases.length < 3) throw new Error(`expected several cases, found ${v.cases.length}`);
if (!v.source.includes("ed25519_keypair_blind")) {
  throw new Error(`the values must come from tor's blinding, not ours — source is ${v.source}`);
}
// Distinct blinded keys across cases, or a derivation that ignored its inputs would pass.
if (new Set(v.cases.map((c) => c.blindedSecret)).size !== v.cases.length) {
  throw new Error("two cases share a blinded secret, so the inputs are not being used");
}

function ref(what: number, a: Uint8Array, _b: Uint8Array): Uint8Array {
  if (what === B_COUNT) return new Uint8Array([v.cases.length]);
  const c = v.cases[a[0]];
  switch (what) {
    case B_SEED:
      return hex(c.seed);
    case B_FACTOR:
      return hex(c.factor);
    case B_IDENTITY_SECRET:
      return hex(c.identitySecret);
    case B_IDENTITY_PUBLIC:
      return hex(c.identityPublic);
    case B_BLINDED_SECRET:
      return hex(c.blindedSecret);
    case B_BLINDED_PUBLIC:
      return hex(c.blindedPublic);
    case B_SIGNATURE:
      return hex(c.signature);
    case B_MESSAGE:
      return utf8(c.message);
    default:
      throw new Error(`unknown vector field ${what}`);
  }
}

await wacTestRun("packages/tor/test/wac/blind_test.wac", "blind", [ref]);
