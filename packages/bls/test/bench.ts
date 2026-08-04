// Where the time in a signature verification goes.
//
//   deno run -A packages/bls/test/bench.ts
//
// Not a `.test.ts`, so the suite does not run it. It exists because every optimisation in this
// package so far came from this profile disagreeing with what I expected, and twice from it
// contradicting a change I had already convinced myself was a win. Anyone continuing the work
// should run it before choosing what to touch.
//
// Reading the numbers:
//
//   * `Miller, two pairs` and `Miller, one pair` each include their own point decoding — the
//     two-pair probe decodes four points and the one-pair probe two — so the raw column compares
//     directly with twice the one-pair raw figure, and the shared-accumulator saving is the gap
//     between them. Subtracting a single decode from each over-charges the shared loop, which is
//     a mistake this file made once.
//   * `full verify` is the only number that matters; the rest are for deciding where to look.
//   * Every figure is the best of three runs, because the noise is one-sided — a slow run means
//     something else on the machine, never faster arithmetic.
//
// There is no comparison against another implementation here on purpose: pulling `@noble/curves`
// in would put an npm dependency in `deno.lock` for a benchmark. Its number is in the README.

import { wacBind } from "../../../harness/wacBind.ts";

const probe = await wacBind("packages/bls/test/wac/probe.wac") as unknown as {
  blsG1Status(s: Uint8Array): number;
  blsG2Status(s: Uint8Array): number;
  blsHashToG2(msg: Uint8Array, dst: Uint8Array): Uint8Array;
  blsMillerLoop(g1c: Uint8Array, g2c: Uint8Array): Uint8Array;
  blsMillerLoopTwo(a1: Uint8Array, b1: Uint8Array, a2: Uint8Array, b2: Uint8Array): Uint8Array;
  blsPairing(g1c: Uint8Array, g2c: Uint8Array): Uint8Array;
  blsVerify(pk: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean;
  blsBatchVerify(pks: Uint8Array[], msgs: Uint8Array[], sigs: Uint8Array[], e: Uint8Array): boolean;
  blsFastAggregateVerify(pks: Uint8Array[], msg: Uint8Array, sig: Uint8Array): boolean;
};

const hexBytes = (h: string) =>
  Uint8Array.from((h.startsWith("0x") ? h.slice(2) : h).match(/../g)!.map((x) => parseInt(x, 16)));

// A fixture that verifies, so every path runs to completion rather than short-circuiting on a
// refusal — a benchmark of the rejection path would be measuring the wrong thing entirely.
const fixtures = JSON.parse(
  await Deno.readTextFile(new URL("vendor/eth_verify.json", import.meta.url)),
) as Record<string, { input: { pubkey: string; message: string; signature: string }; output: boolean }>;
const good = Object.values(fixtures).find((c) => c.output);
if (!good) throw new Error("no verifying fixture in eth_verify.json");
const pk = hexBytes(good.input.pubkey);
const sig = hexBytes(good.input.signature);
const msg = hexBytes(good.input.message);
if (!probe.blsVerify(pk, msg, sig)) throw new Error("the fixture does not verify — fix that first");

const best = (n: number, f: () => unknown) => {
  f();
  let ms = Infinity;
  for (let round = 0; round < 3; round++) {
    const start = performance.now();
    for (let i = 0; i < n; i++) f();
    ms = Math.min(ms, (performance.now() - start) / n);
  }
  return ms;
};

const g1 = best(60, () => probe.blsG1Status(pk));
const g2 = best(60, () => probe.blsG2Status(sig));
const decodeBoth = best(40, () => {
  probe.blsG1Status(pk);
  probe.blsG2Status(sig);
});
const hash = best(30, () => probe.blsHashToG2(msg, new Uint8Array(0)));
const one = best(25, () => probe.blsMillerLoop(pk, sig));
const two = best(20, () => probe.blsMillerLoopTwo(pk, sig, pk, sig));
const paired = best(20, () => probe.blsPairing(pk, sig));
const whole = best(25, () => probe.blsVerify(pk, msg, sig));

const ms = (x: number) => x.toFixed(2).padStart(6);
const share = (x: number) => `${((x / whole) * 100).toFixed(0)}%`.padStart(4);
console.log(`G1 decode + subgroup   ${ms(g1)} ms   ${share(g1)}`);
console.log(`G2 decode + subgroup   ${ms(g2)} ms   ${share(g2)}`);
console.log(`hash_to_G2             ${ms(hash)} ms   ${share(hash)}`);
console.log(`Miller, two pairs      ${ms(two - decodeBoth)} ms   ${share(two - decodeBoth)}` +
  `   raw ${ms(two)} against ${ms(2 * one)} for two separate loops`);
console.log(`final exponentiation   ${ms(paired - one)} ms   ${share(paired - one)}`);
console.log(`${"-".repeat(22)} ${ms(whole)} ms          full verification`);

// ── Batching ──────────────────────────────────────────────────────────────────
//
// What the aggregate operations are for. A batch of n costs n+1 pairings through one Miller loop
// and **one** final exponentiation, against n separate verifications at two pairings and one final
// exponentiation each.
//
// The batch is built by repeating one valid triple, which is degenerate cryptographically — every
// member is the same signature — and exactly representative for timing, because the weights differ
// per index so the arithmetic is the same work as n distinct members.
console.log();
const sizes = [1, 2, 4, 8, 16];
console.log(`${"n".padStart(3)}  ${"individually".padStart(13)}  ${"batched".padStart(9)}  speedup   per signature`);
for (const n of sizes) {
  const pks = Array.from({ length: n }, () => pk);
  const msgs = Array.from({ length: n }, () => msg);
  const sigs = Array.from({ length: n }, () => sig);
  const entropy = new Uint8Array(0);
  if (!probe.blsBatchVerify(pks, msgs, sigs, entropy)) {
    throw new Error(`the synthetic batch of ${n} does not verify — the figures below would be noise`);
  }
  const one = best(Math.max(3, Math.floor(40 / n)), () => {
    for (let i = 0; i < n; i++) probe.blsVerify(pk, msg, sig);
  });
  const batch = best(Math.max(3, Math.floor(40 / n)), () => probe.blsBatchVerify(pks, msgs, sigs, entropy));
  console.log(
    `${String(n).padStart(3)}  ${ms(one)} ms  ${ms(batch)} ms  ${(one / batch).toFixed(2)}x   ` +
      `${ms(batch / n)} ms`,
  );
}

// FastAggregateVerify is the cheap one: many signers on one message sum to a single verification.
const fa = best(20, () => probe.blsFastAggregateVerify([pk, pk, pk, pk], msg, sig));
console.log(`\nfastAggregateVerify, 4 keys, 1 message   ${ms(fa)} ms` +
  `   (4 separate verifications: ${ms(best(10, () => { for (let i = 0; i < 4; i++) probe.blsVerify(pk, msg, sig); }))} ms)`);
