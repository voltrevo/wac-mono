// `verify`, against `ethereum/bls12-381-tests`.
//
// The oracle this whole package was built toward: 29 consensus-critical cases, most of them
// refusals, from an external project that had no idea this implementation exists. The names are
// the specification — `verify_infinity_pubkey_and_infinity_signature`,
// `verify_wrong_pubkey_valid_sig`, `verify_tampered_signature_case_…` — and they cover the
// policies no amount of arithmetic testing reaches.
//
// This is also the only test of the final exponentiation that means anything. The pairing's
// absolute value differs from other libraries' by a constant power, so the identity
// `e(pk,H)·e(−G1,sig) == 1` is what must hold, and a wrong chain fails it.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/bls/test/wac/probe.wac") as unknown as {
  blsVerify(pubkey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean;
};

type Case = {
  input: { pubkey: string; message: string; signature: string };
  output: boolean;
};
const cases: Record<string, Case> = JSON.parse(
  await Deno.readTextFile(new URL("vendor/eth_verify.json", import.meta.url)),
);
const bytes = (h: string) =>
  Uint8Array.from((h.startsWith("0x") ? h.slice(2) : h).match(/../g)?.map((x) => parseInt(x, 16)) ?? []);

Deno.test("every Ethereum verify fixture agrees", () => {
  const failures: string[] = [];
  let accepted = 0;
  let refused = 0;
  for (const [name, c] of Object.entries(cases)) {
    const got = mod.blsVerify(
      bytes(c.input.pubkey), bytes(c.input.message), bytes(c.input.signature),
    );
    if (c.output) accepted++; else refused++;
    if (got !== c.output) failures.push(`  ${name}: got ${got}, want ${c.output}`);
  }
  // A corpus of only refusals would pass with `return false`, so assert the shape of it too.
  if (accepted === 0) throw new Error("no accepting cases — the corpus is not what it claims");
  if (refused === 0) throw new Error("no refusing cases — the corpus is not what it claims");
  if (failures.length > 0) {
    throw new Error(`${failures.length} of ${accepted + refused} fixtures disagree ` +
      `(${accepted} should accept, ${refused} should refuse):\n${failures.join("\n")}`);
  }
});

Deno.test("every Ethereum deserialization fixture agrees, G1 and G2", async () => {
  // 28 more external cases, all about the encodings — which is where the security lives and where
  // my own generated vectors could only guess at what an implementer gets wrong. Their names are
  // the specification: `deserialization_fails_infinity_with_true_b_flag`,
  // `deserialization_fails_too_few_bytes`, `deserialization_fails_not_in_curve`.
  const probe = mod as unknown as { blsG1Status(s: Uint8Array): number; blsG2Status(s: Uint8Array): number };
  const failures: string[] = [];
  for (const [group, key, status] of [
    ["G1", "pubkey", probe.blsG1Status], ["G2", "signature", probe.blsG2Status],
  ] as [string, string, (s: Uint8Array) => number][]) {
    const file = `vendor/eth_deserialization_${group}.json`;
    const cases: Record<string, { input: Record<string, string>; output: boolean }> =
      JSON.parse(await Deno.readTextFile(new URL(file, import.meta.url)));
    for (const [name, c] of Object.entries(cases)) {
      const got = status(bytes(c.input[key])) === 0;
      if (got !== c.output) failures.push(`  ${group} ${name}: got ${got}, want ${c.output}`);
    }
  }
  if (failures.length > 0) throw new Error(`${failures.length} disagree:\n${failures.join("\n")}`);
});
