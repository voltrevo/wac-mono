# bls

BLS signature verification on BLS12-381 — the Ethereum parameters and encodings.

**Verification only, deliberately.** No signing, no key generation, no secret material anywhere
in the package. That is a scope decision with a useful consequence: verification runs entirely on
public inputs, so nothing here needs to be constant-time, and the whole class of timing bug that
makes elliptic-curve code hard to write does not arise. If signing is ever wanted it belongs in a
different file with `ctTrace` over it, not bolted onto these functions.

## Status

**Working.** `verify(pubkey, message, signature)` agrees with all 29 `ethereum/bls12-381-tests`
verify fixtures and all 28 deserialization fixtures, at about **15 ms** per signature.

Built in stages with an external oracle gating each one:

| stage | state |
| ----- | ----- |
| `Fp` — the 381-bit base field, Montgomery form | **done**, against Python |
| `Fp` inversion and square roots | **done**, against Python |
| `Fp2` — the quadratic extension | **done**, against Python |
| `Fp6` / `Fp12` — the rest of the tower, with Frobenius | **done**, against Python |
| `G1` — points, subgroup check, compressed encoding | **done**, against Python |
| `G2` — the same over Fp2, and Fp2 square roots | **done**, against Python |
| `expand_message_xmd` + `hash_to_field` | **done**, against the CFRG vectors |
| `map_to_curve` — SSWU and the 3-isogeny | **done**, against `Q0`/`Q1` |
| `clear_cofactor` and `hash_to_G2` | **done**, against `P` and Ethereum's fixtures |
| Miller loop | **done**, against `@noble/curves` via Python |
| Final exponentiation | **done**, via the verification identity |
| `verify` | **done** — all 29 Ethereum fixtures, plus 28 deserialization |

## Why none of `crypto/src/fieldp.wac` is reused

That file does P-256 and P-384 from one implementation because both are **Solinas** primes:
reduction is limb shuffles and additions with no multiplication at all. BLS12-381's base field
prime has no such structure, so reduction needs a real multiply and none of that design carries
over. `crypto/src/rsa.wac` says outright that naive `modPow` was fast enough that Montgomery form
was not worth it there, so there was no Montgomery arithmetic in the repo to build on either.

What *is* reused: `crypto`'s SHA-256, once `hash_to_G2` exists.

## The oracle, and the trap it exists to avoid

**Do not validate a pairing with bilinearity.** `e(aP, bQ) == e(P, Q)^(ab)` is a *symmetric*
oracle: it checks the implementation against itself and passes cheerfully with the wrong twist, a
wrong final-exponentiation exponent, or a consistently-wrong Frobenius. Pairing code is notorious
for this. Every stage here is checked against something external instead:

- `Fp` and the tower — `test/vectors.py` and `test/tower.py`, which use Python's own integers and
  share no code, representation or author's misreading with the implementation.

  The Frobenius constants get a second, sharper check. There are nine of them, each twelve 32-bit
  words, and a single wrong digit gives a pairing that is entirely self-consistent and matches no
  published value. `tower.py` therefore validates Frobenius-by-constants against **actually
  raising to the pⁿ-th power** in the tower, so a bad table fails there before any wac runs. The
  wac tables were emitted by script and pasted, never typed. Montgomery form in particular
  satisfies `a·1 == a` and `a + 0 == a` with a completely broken reduction, so a self-relation
  would prove almost nothing.
- `hash_to_G2` — RFC 9380 §J.10's published vectors.
- `verify` — the `ethereum/bls12-381-tests` fixtures, which are the consensus-critical cases and
  include the encoding edges where the security actually lives: the infinity pubkey, non-canonical
  encodings, and points off the correct subgroup.

Vectors are vendored rather than fetched, so the tests need no network.

## Speed, stated up front

**Measured: 15.2 ms per verification**, against 14.6 ms for `@noble/curves` on the same machine and
about 1 ms for `blst`. It started at 109 ms. Wasm has no 64×64→128 multiply and no carry flag, so
`Fp` uses twelve 32-bit limbs with a 64-bit accumulator, 144 partial products per multiply, because
`i64` is the widest multiply the machine has. A verification is two Miller loops sharing one
accumulator and one final exponentiation, order 20,000 field multiplications.

Run `deno run -A packages/bls/test/bench.ts` for the current split. As of 2026-08-04:

| stage | | |
| ----- | --- | --- |
| Miller loop, both pairs | 7.8 ms | 51% |
| final exponentiation | 4.3 ms | 28% |
| `hash_to_G2` | 2.8 ms | 18% |
| G2 decode + subgroup check | 1.2 ms | 8% |
| G1 decode + subgroup check | 0.7 ms | 4% |

### What the 109 → 15 ms came from, and what it cost to find

Every one of these was chosen by the profile, and three of them contradicted what I expected before
measuring. They are listed with their sizes because the sizes are the useful part:

| change | saved |
| ------ | ----- |
| `halve` recomputed 1/2 by Fermat inversion on every call | 58 ms |
| Budroni–Pintore cofactor clearing instead of a 636-bit `h_eff` | 12 ms |
| one square root in SSWU instead of two, and complex `fp12Square` | 10 ms |
| `fpInvert` by binary extended GCD instead of Fermat | 2.6 ms |
| Granger–Scott cyclotomic squaring in the final exponentiation | 3.9 ms |
| `g1InSubgroup` by the φ endomorphism instead of multiplying by r | 1.3 ms |
| one Miller loop over both pairs, sharing the 64 Fp12 squarings | 1.1 ms |
| CIOS reduction storing to `t[j-1]`, so no separate shift pass | 1.1 ms |
| reducing against `P0..P11` constants instead of a rebuilt array | 1.0 ms |

Two hypotheses that did **not** survive measurement, recorded because they were expensive to hold:

- **Allocation was going to dominate.** It does not. A `u32[12]` costs 5–7 ns to allocate, so the
  tree of 21 objects behind an `Fp12` is about 1 ms of a 36 ms Miller loop. `test/wac/flat.wac`
  re-tested this properly by rewriting the Montgomery multiply three ways, and a fully flat
  zero-allocation version came out *slower* than the allocating one. The same experiment found the
  opposite for addition — 44% — which is where the `P0..P11` change came from.
- **Reordering the mutation suite was worth a multiple.** Measured, 9.5%. See wac-mono issue 0024.

### Still untaken, roughly in order of what the profile says they are worth

- The Miller loop's per-pair work is half the total and has had no attention beyond using the
  sparse `mul014` line function. 384-bit Karatsuba inside `fpMul` would cut 144 limb products to
  about 108 and is the largest single item left.
- Three scalar multiplications by 64-bit |x| remain per verification — one in `g2InSubgroup`, two
  in `clearCofactorG2` — at roughly 0.5 ms each. The doublings are irreducible for a fixed scalar,
  so only a cheaper `g2Double` helps.
- Karabina compressed squaring would beat Granger–Scott in the final exponentiation, at the cost of
  a decompression step.
- Batch and aggregate verification share one final exponentiation across many signatures. The
  fixtures are already vendored (`eth_batch_verify.json`, `eth_aggregate_verify.json`) and unused.

### A caveat that is not about speed

`fpInvert` is no longer constant time — binary extended GCD branches on the value. That is safe
here because nothing secret is ever inverted: a verifier handles public keys, signatures and
messages only. A **signing** implementation must not reuse it as it stands. It says so at the
function too.
