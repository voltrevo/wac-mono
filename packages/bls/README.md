# bls

BLS signature verification on BLS12-381 — the Ethereum parameters and encodings.

**Verification only, deliberately.** No signing, no key generation, no secret material anywhere
in the package. That is a scope decision with a useful consequence: verification runs entirely on
public inputs, so nothing here needs to be constant-time, and the whole class of timing bug that
makes elliptic-curve code hard to write does not arise. If signing is ever wanted it belongs in a
different file with `ctTrace` over it, not bolted onto these functions.

## Status

**Working.** `verify(pubkey, message, signature)` agrees with all 29 `ethereum/bls12-381-tests`
verify fixtures and all 28 deserialization fixtures, at about **8 ms** per signature.

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

**Measured: 7.9 ms per verification**, against 14.6 ms for `@noble/curves` on the same machine and
about 1 ms for `blst`. It started at 109 ms. A verification is two Miller loops sharing one
accumulator and one final exponentiation, order 20,000 field multiplications.

Wasm has no 64×64→128 multiply and no carry flag, so `Fp` uses twelve 32-bit limbs with a 64-bit
accumulator — 144 partial products per multiply, because `i64` is the widest multiply the machine
has. The arithmetic kernel is therefore generated: see **`tools/genfpkernel.py`**, which holds the
measurements that made it so and the two optimisations they ruled out.

Run `deno run -A test/bench.ts` for the current split. As of 2026-08-04:

| stage | | |
| ----- | --- | --- |
| Miller loop, both pairs | 4.0 ms | 51% |
| final exponentiation | 2.5 ms | 32% |
| `hash_to_G2` | 1.3 ms | 17% |
| G2 decode + subgroup check | 0.5 ms | 7% |
| G1 decode + subgroup check | 0.3 ms | 4% |

### What 109 → 7.9 ms came from

Every one of these was chosen by the profile, and four contradicted what I expected before
measuring. The sizes are the useful part:

| change | saved |
| ------ | ----- |
| `halve` recomputed 1/2 by Fermat inversion on every call | 58 ms |
| unrolling the Fp kernel into locals with p as immediates | 7.4 ms |
| Budroni–Pintore cofactor clearing instead of a 636-bit `h_eff` | 12 ms |
| one square root in SSWU instead of two, and complex `fp12Square` | 10 ms |
| Granger–Scott cyclotomic squaring in the final exponentiation | 3.9 ms |
| `fpInvert` by binary extended GCD instead of Fermat | 2.6 ms |
| `g1InSubgroup` by the φ endomorphism instead of multiplying by r | 1.3 ms |
| one Miller loop over both pairs, sharing the 64 Fp12 squarings | 1.1 ms |
| CIOS reduction storing to `t[j-1]`, so no separate shift pass | 1.1 ms |

### Four hypotheses that did not survive measurement

Recorded because each was expensive to hold, and because three of them were about to become work.

- **Allocation was going to dominate.** It does not. A `u32[12]` costs 5–7 ns, so the tree of 21
  objects behind an `Fp12` was about 1 ms of a 36 ms Miller loop.
- **A fixed-size array type would fix that.** `test/wac/flat.wac` rewrote the Montgomery multiply
  three ways and a zero-allocation version came out *slower* than the allocating one. The same
  experiment found the opposite for addition — 44% — which is where the immediates came from.
- **384-bit Karatsuba was the next big win.** It cuts 144 limb products to about 108, but a limb
  addition costs about what a limb multiply-accumulate costs here, and Karatsuba pays ~70 extra
  additions to save 36 multiplies. A loss at this size. The multiplication *count* was never the
  lever: two thirds of a field multiply was loop overhead, bounds checks and array traffic.
- **A dedicated squaring was worth writing.** `fpSquare` is `fpMul(a, a)` and computes every
  off-diagonal product twice. All of `fpSquare` is 0.59 ms of 8.65, so the ceiling is ~0.14 ms —
  1.6% — for several hundred lines of the carry handling that squaring implementations get wrong.
- **Lazy-carry product scanning would help.** Narrower limbs leave headroom to accumulate a whole
  column before normalising, which is 38% fewer operations. Built and measured: **56% slower**, 179 ns
  against 114. Register pressure and multiply throughput were both tested and neither explains it.
  `tools/genfips-experiment.py` regenerates it. The one finding that outlived it: 30-bit limbs are
  faster and can *provably* overflow the accumulator at 2^64.304, while 43 random pairs including
  (p−1)² peaked at 2^63.1 and looked safe.

Four wrong predictions from operation counts, and one case where the same arithmetic under-predicted
by a mile — unrolling the kernel, 64% faster at an unchanged op count. **In this environment op
counts do not predict runtime in either direction.** Measure.

The trick that sized the last two, and the inversion before them: make the function do its work
**twice** and time a whole verification. The delta is the time spent in it, which is otherwise hard
to know with no profiler and no globals to hang a counter on.

### Still untaken

- The Miller loop's per-pair work is half the total and has had no attention beyond the sparse
  `mul014` line function.
- Three scalar multiplications by 64-bit |x| remain per verification — one in `g2InSubgroup`, two in
  `clearCofactorG2`. The doublings are irreducible for a fixed scalar, so only a cheaper `g2Double`
  helps.
- Karabina compressed squaring would beat Granger–Scott, at the cost of a decompression step.
- Batch and aggregate verification share one final exponentiation across many signatures. The
  fixtures are vendored (`eth_batch_verify.json`, `eth_aggregate_verify.json`) and unused.

### Two caveats that are not about speed

`fpInvert` is no longer constant time — binary extended GCD branches on the value. Safe here because
nothing secret is ever inverted: a verifier handles public keys, signatures and messages only. A
**signing** implementation must not reuse it as it stands. It says so at the function too.

`src/fpkernel.wac` is generated and must not be edited. `test/fpkernel_generated.test.ts` fails if
it is not what `tools/genfpkernel.py` produces; run `deno task gen:bls-fpkernel` after changing the
generator. It also makes the package's mutation sweep large — see wac-mono issue 0027.
