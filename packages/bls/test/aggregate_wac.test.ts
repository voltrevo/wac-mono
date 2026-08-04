// Aggregate and batch verification, against Ethereum's own fixtures.
//
// These are the consensus-critical cases and the reason the operations are worth having: a beacon
// chain block verifies thousands of signatures, and the saving is one final exponentiation for the
// batch instead of one each.
//
// The fixtures are doing real adversarial work here, more than in `verify`'s case:
//
//   - `aggregate_verify_infinity_pubkey` has four keys, one of them the point at infinity. It
//     catches an implementation that checks the *aggregate* for infinity rather than each key,
//     because a sum containing infinity is an ordinary point.
//   - `batch_verify_invalid_forged_signature_set` is the attack on unweighted batching: move a point
//     X from one signature to another and the naive product still comes to one. Only the random
//     weights reject it, so this fixture is what distinguishes a real batch verifier from a wrong
//     one that passes everything else.
//   - every `na_pubkeys` case has an empty key list, which must refuse rather than return the
//     identity and verify vacuously.
//
// A note on what is *not* tested here: that a failing batch says *which* signature failed. It
// cannot — the terms are summed — and `batchVerify`'s comment says so.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/bls/test/wac/probe.wac") as unknown as {
  blsAggregate(sigs: Uint8Array[]): Uint8Array;
  blsFastAggregateVerify(pks: Uint8Array[], msg: Uint8Array, sig: Uint8Array): boolean;
  blsAggregateVerify(pks: Uint8Array[], msgs: Uint8Array[], sig: Uint8Array): boolean;
  blsBatchVerify(
    pks: Uint8Array[],
    msgs: Uint8Array[],
    sigs: Uint8Array[],
    entropy: Uint8Array,
  ): boolean;
  blsVerify(pk: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean;
  blsBatchScalar(
    pks: Uint8Array[], msgs: Uint8Array[], sigs: Uint8Array[], entropy: Uint8Array, i: number,
  ): Uint32Array;
};

const bytes = (h: string) =>
  Uint8Array.from((h.startsWith("0x") ? h.slice(2) : h).match(/../g)!.map((x) => parseInt(x, 16)));
const load = async (name: string) =>
  JSON.parse(await Deno.readTextFile(new URL(`vendor/${name}.json`, import.meta.url)));
const NO_ENTROPY = new Uint8Array(0);

Deno.test("every Ethereum fast_aggregate_verify fixture agrees", async () => {
  const cases = await load("eth_fast_aggregate_verify") as Record<
    string,
    { input: { pubkeys: string[]; message: string; signature: string }; output: boolean }
  >;
  let ran = 0;
  for (const [name, c] of Object.entries(cases)) {
    const got = mod.blsFastAggregateVerify(
      c.input.pubkeys.map(bytes),
      bytes(c.input.message),
      bytes(c.input.signature),
    );
    if (got !== c.output) {
      throw new Error(`${name}: got ${got}, want ${c.output} (${c.input.pubkeys.length} pubkeys)`);
    }
    ran++;
  }
  if (ran !== 12) throw new Error(`expected 12 fixtures, ran ${ran}`);
});

Deno.test("every Ethereum aggregate_verify fixture agrees", async () => {
  const cases = await load("eth_aggregate_verify") as Record<
    string,
    { input: { pubkeys: string[]; messages: string[]; signature: string }; output: boolean }
  >;
  let ran = 0;
  for (const [name, c] of Object.entries(cases)) {
    const got = mod.blsAggregateVerify(
      c.input.pubkeys.map(bytes),
      c.input.messages.map(bytes),
      bytes(c.input.signature),
    );
    if (got !== c.output) {
      throw new Error(`${name}: got ${got}, want ${c.output} (${c.input.pubkeys.length} pubkeys)`);
    }
    ran++;
  }
  if (ran !== 5) throw new Error(`expected 5 fixtures, ran ${ran}`);
});

Deno.test("every Ethereum batch_verify fixture agrees", async () => {
  const cases = await load("eth_batch_verify") as Record<
    string,
    { input: { pubkeys: string[]; messages: string[]; signatures: string[] }; output: boolean }
  >;
  let ran = 0, forged = 0;
  for (const [name, c] of Object.entries(cases)) {
    const got = mod.blsBatchVerify(
      c.input.pubkeys.map(bytes),
      c.input.messages.map(bytes),
      c.input.signatures.map(bytes),
      NO_ENTROPY,
    );
    if (got !== c.output) {
      throw new Error(`${name}: got ${got}, want ${c.output} (${c.input.pubkeys.length} signatures)`);
    }
    if (name.includes("forged")) forged++;
    ran++;
  }
  if (ran !== 4) throw new Error(`expected 4 fixtures, ran ${ran}`);
  // Named explicitly: this is the one case that separates a weighted batch verifier from a broken
  // one, and it would be easy to lose it in a refactor of the fixture file.
  if (forged !== 1) throw new Error("the forged-signature-set fixture is missing from the batch");
});

Deno.test("the batch weights are what reject a forged set, not the fixtures being easy", async () => {
  // Reconstruct the forgery independently of the vendored case, so this test states the property
  // rather than trusting one file: take two valid signature sets and move nothing at all, then
  // swap the two signatures. Each signature is valid for *a* message in the batch and invalid for
  // the one it is now paired with, and the sum is unchanged — which is exactly the shape an
  // unweighted product cannot see.
  const cases = await load("eth_batch_verify") as Record<
    string,
    { input: { pubkeys: string[]; messages: string[]; signatures: string[] }; output: boolean }
  >;
  const valid = Object.entries(cases).find(([n, c]) => c.output && c.input.pubkeys.length >= 2);
  if (valid === undefined) throw new Error("no valid multi-signature fixture to build on");
  const [, c] = valid;
  const pks = c.input.pubkeys.map(bytes);
  const msgs = c.input.messages.map(bytes);
  const sigs = c.input.signatures.map(bytes);

  if (!mod.blsBatchVerify(pks, msgs, sigs, NO_ENTROPY)) {
    throw new Error("the base set does not verify, so the negative below proves nothing");
  }
  // Sanity: the members really are distinct signatures on distinct messages.
  if (msgs[0].every((b, i) => b === msgs[1][i])) throw new Error("messages 0 and 1 are identical");

  const swapped = [sigs[1], sigs[0], ...sigs.slice(2)];
  if (mod.blsBatchVerify(pks, msgs, swapped, NO_ENTROPY)) {
    throw new Error("a batch with two signatures swapped verified — the weights are not working");
  }
  // And each swapped pairing genuinely fails on its own, so the batch is rejecting the right thing.
  if (mod.blsVerify(pks[0], msgs[0], sigs[1])) throw new Error("swapped pair 0 verifies alone");
});

Deno.test("entropy changes the weights but not the verdict", async () => {
  const cases = await load("eth_batch_verify") as Record<
    string,
    { input: { pubkeys: string[]; messages: string[]; signatures: string[] }; output: boolean }
  >;
  for (const [name, c] of Object.entries(cases)) {
    const pks = c.input.pubkeys.map(bytes);
    const msgs = c.input.messages.map(bytes);
    const sigs = c.input.signatures.map(bytes);
    for (const e of [new Uint8Array([1]), new Uint8Array([0xff, 0x00, 0x7a]), NO_ENTROPY]) {
      const got = mod.blsBatchVerify(pks, msgs, sigs, e);
      if (got !== c.output) {
        throw new Error(`${name}: entropy [${e}] changed the verdict to ${got}, want ${c.output}`);
      }
    }
  }
});

Deno.test("aggregation refuses an empty list and a bad member, and round-trips otherwise", async () => {
  const cases = await load("eth_fast_aggregate_verify") as Record<
    string,
    { input: { pubkeys: string[]; message: string; signature: string }; output: boolean }
  >;
  if (mod.blsAggregate([]).length !== 0) throw new Error("aggregating nothing produced a signature");
  if (mod.blsAggregate([new Uint8Array(96)]).length !== 0) {
    throw new Error("aggregating an all-zero (non-canonical) signature produced one");
  }

  // Aggregating one valid signature must give that signature back: a sum with the identity.
  const good = Object.values(cases).find((c) => c.output);
  if (good === undefined) throw new Error("no valid fixture");
  const sig = bytes(good.input.signature);
  const agg = mod.blsAggregate([sig]);
  const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
  if (hex(agg) !== hex(sig)) {
    throw new Error(`aggregating one signature changed it\n  in  ${hex(sig)}\n  out ${hex(agg)}`);
  }
});

Deno.test("a batch weight depends on the whole batch, not just its position", async () => {
  // Gutting `batchTranscript` to return nothing survived a mutation sweep: with an empty transcript
  // the weights become `H(i)`, still non-trivial and still enough to reject the vendored forged set —
  // but *predictable*, which is precisely what the weights exist to prevent. An adversary who knows
  // the implementation can then choose a forgery that survives the product.
  //
  // No fixture can catch that, because catching it needs an adversary who adapts to the weights. So
  // the property is asserted directly: change any part of the batch and the weights must move.
  const cases = await load("eth_batch_verify") as Record<
    string,
    { input: { pubkeys: string[]; messages: string[]; signatures: string[] }; output: boolean }
  >;
  const c = Object.values(cases).find((x) => x.output && x.input.pubkeys.length >= 2);
  if (c === undefined) throw new Error("no valid multi-signature fixture");
  const pks = c.input.pubkeys.map(bytes);
  const msgs = c.input.messages.map(bytes);
  const sigs = c.input.signatures.map(bytes);
  const w = (p = pks, m = msgs, s = sigs, e = NO_ENTROPY, i = 0) =>
    Array.from(mod.blsBatchScalar(p, m, s, e, i)).join(",");

  const base = w();
  if (base === "0,0") throw new Error("the weight is zero, which would drop the term entirely");

  // Every input to the transcript must move it. A flipped bit in any of the three lists, or in the
  // entropy, or a different index.
  const flip = (list: Uint8Array[], at: number) => {
    const copy = list.map((x) => x.slice());
    copy[at][0] ^= 1;
    return copy;
  };
  const moved: [string, string][] = [
    ["a public key", w(flip(pks, 0))],
    ["a later public key", w(flip(pks, 1))],
    ["a message", w(pks, flip(msgs, 0))],
    ["a signature", w(pks, msgs, flip(sigs, 0))],
    ["a later signature", w(pks, msgs, flip(sigs, 1))],
    ["the entropy", w(pks, msgs, sigs, new Uint8Array([7]))],
    ["the term index", w(pks, msgs, sigs, NO_ENTROPY, 1)],
  ];
  for (const [what, got] of moved) {
    if (got === base) {
      throw new Error(
        `changing ${what} left the weight unchanged — the batch is not bound into it, so the ` +
          `weights are predictable and the forgery defence is gone`,
      );
    }
  }
  // Distinct weights per term, too: identical weights would collapse the batch to an unweighted sum.
  const perTerm = new Set([0, 1].map((i) => w(pks, msgs, sigs, NO_ENTROPY, i)));
  if (perTerm.size !== 2) throw new Error("terms 0 and 1 got the same weight");
});
