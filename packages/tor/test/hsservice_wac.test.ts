// Registers the wac-side ESTABLISH_INTRO tests: the first cell an onion service sends.
//
// The oracle is `test/data/estintro_vectors.json`, captured by `tools/capture-estintro.py`, which
// puts the cell through tor's own `trn_cell_establish_intro_parse` and then tor's own
// `crypto_mac_sha3_256` and `ed25519_checksig_prefixed`. Unlike a microdescriptor's, this verdict is
// worth something on its own: the cell carries both a MAC and a signature and tor checks both, so
// every mutation in the fixture is refused. That is recorded rather than assumed — the mutation list
// is loaded and checked to be non-empty and all-refused before anything is asserted on it.
//
// **The span is the thing.** `end_sig_fields` sits after the handshake MAC and before `sig_len`, so
// the signature covers the MAC and *not* the two length bytes that follow it. Signing "everything
// before the signature" — the obvious reading — produces a cell that parses, whose MAC verifies, and
// whose signature tor refuses. That cell is in the fixture as its own mutation, so the trap is
// measured here rather than described in a comment.
//
// **Node signs the same bytes independently.** `ed25519Sign` in this repo is good and it is the wrong
// tool for checking itself: our signer feeding our verifier can agree on a wrong answer. node:crypto
// shares no code with us, so it can only reproduce our signature if the span and the key are actually
// right — the same argument `routerdesc_wac.test.ts` makes for the descriptor certificates.

import { createPrivateKey, sign as nodeSign } from "node:crypto";
import { wacTestRun } from "../../../harness/wacTestRun.ts";

const E_AUTH_SEED = 0;
const E_AUTH_PUBLIC = 1;
const E_KH = 2;
const E_CELL = 3; // the cell tor parsed and verified, byte for byte
const E_MAC_SPAN_LEN = 4; // 4 bytes big-endian: where tor says the MAC span ends
const E_SIG_SPAN_LEN = 5; // 4 bytes big-endian: where tor says the SIGNATURE span ends
const E_NODE_SIG = 6; // a = the message; node's signature over it with the same seed

const v = JSON.parse(
  await Deno.readTextFile(new URL("data/estintro_vectors.json", import.meta.url)),
) as {
  authSeed: string;
  authPublic: string;
  circuitKH: string;
  cell: string;
  macSpanLen: number;
  sigSpanLen: number;
  torSpans: { macSpanLen: number; sigSpanLen: number };
  torParsedBytes: number;
  mutations: { name: string; accepted: boolean; reason: string }[];
};

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

// The fixture must record tor accepting the unmodified cell and refusing every mutation, or the
// assertions below are about nothing. Checked at load time so the failure names the fixture rather
// than appearing as a confusing wac assertion.
if (v.mutations.length < 3) throw new Error("too few mutations to show the verdict discriminates");
for (const m of v.mutations) {
  if (m.accepted) throw new Error(`mutation "${m.name}" was accepted, so ACCEPTED means nothing`);
}
if (!v.mutations.some((m) => m.name.includes("obvious span"))) {
  throw new Error("the signature-span trap is not in the fixture, so nothing pins the span");
}
if (v.torParsedBytes !== hex(v.cell).length) {
  throw new Error(`tor parsed ${v.torParsedBytes} of ${hex(v.cell).length} bytes`);
}

const be32 = (n: number) => {
  const out = new Uint8Array(4);
  for (let i = 3; i >= 0; i--) out[i] = (n >> (8 * (3 - i))) & 0xff;
  return out;
};

/** node's Ed25519 over a message, with the vector's own seed. */
function nodeSignature(msg: Uint8Array): Uint8Array {
  // PKCS#8 is the only shape node takes a raw Ed25519 seed in.
  const der = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
    ...hex(v.authSeed),
  ]);
  const key = createPrivateKey({ key: der as unknown as Buffer, format: "der", type: "pkcs8" });
  return new Uint8Array(nodeSign(null, msg, key));
}

function ref(what: number, a: Uint8Array, _b: Uint8Array): Uint8Array {
  switch (what) {
    case E_AUTH_SEED:
      return hex(v.authSeed);
    case E_AUTH_PUBLIC:
      return hex(v.authPublic);
    case E_KH:
      return hex(v.circuitKH);
    case E_CELL:
      return hex(v.cell);
    case E_MAC_SPAN_LEN:
      return be32(v.torSpans.macSpanLen);
    case E_SIG_SPAN_LEN:
      return be32(v.torSpans.sigSpanLen);
    case E_NODE_SIG:
      return nodeSignature(a);
    default:
      throw new Error(`unknown vector field ${what}`);
  }
}

await wacTestRun("packages/tor/test/wac/hsservice_test.wac", "hsservice", [ref]);
