# bls

BLS signature verification on BLS12-381 — the Ethereum parameters and encodings.

**Verification only, deliberately.** No signing, no key generation, no secret material anywhere
in the package. That is a scope decision with a useful consequence: verification runs entirely on
public inputs, so nothing here needs to be constant-time, and the whole class of timing bug that
makes elliptic-curve code hard to write does not arise. If signing is ever wanted it belongs in a
different file with `ctTrace` over it, not bolted onto these functions.

## Status

**Working.** `verify(pubkey, message, signature)` agrees with all 29 `ethereum/bls12-381-tests`
verify fixtures and all 28 deserialization fixtures, at about **51 ms** per signature.

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

**Measured: 51 ms per verification**, against 14.6 ms for `@noble/curves` on the same machine and
about 1 ms for `blst`. That is within the range predicted before any of it was written — tens to
low hundreds of milliseconds. Wasm has no 64×64→128 multiply and no carry flag, so `Fp` uses twelve 32-bit limbs
with a 64-bit accumulator, 144 partial products per multiply, because `i64` is the widest multiply
the machine has. A verification is two Miller loops sharing one final exponentiation, order 20,000
field multiplications.

The current split is roughly 26 ms for the two Miller loops and one final exponentiation, 18 ms
for `hash_to_G2`, and 8 ms for decoding and subgroup checks. Nothing is optimised beyond one
blunder found by profiling — `halve` used to recompute 1/2 by Fermat inversion on every call, which
was 28 ms of the original 109 — and the remaining levers are known and untaken: `g1InSubgroup` and
`g2InSubgroup` multiply by r rather than using the endomorphism checks, `clearCofactorG2`
multiplies by a 636-bit `h_eff` rather than using Budroni–Pintore, and the final exponentiation
uses plain squaring rather than the cyclotomic kind. Each is noted where it appears. Do not put
this on a hot path without measuring first.
