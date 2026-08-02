# crypto

SHA-256, SHA-512/384, SHA-3, SHAKE, HMAC, HKDF, bcrypt_pbkdf, ChaCha20-Poly1305,
AES-CTR, AES-GCM, X25519, Ed25519, NIST P-256 and P-384, RSA signature verification and
ML-KEM-768, written in wac.

> **Not for production.** Two routines here are known to leak, and the rest are uniform
> only at the level this can measure. See [Side channels](#side-channels) — that section
> is now a measurement rather than a disclaimer, but the conclusion is unchanged: do not
> use this where an attacker can observe timing.

A package of [wac-mono](../../README.md) — see the root README for layout and how
to run things. All commands run from the repo root.

```wac
import { sha256 } from "../../crypto/src/sha256.wac";
import { sha512, sha384 } from "../../crypto/src/sha512.wac";
import { hmacSha256 } from "../../crypto/src/hmac.wac";
import { hkdf } from "../../crypto/src/hkdf.wac";
import { bcryptPbkdf } from "../../crypto/src/bcryptpbkdf.wac";
import { chacha20 } from "../../crypto/src/chacha20.wac";
import { aeadEncrypt, aeadTag, aeadDecrypt } from "../../crypto/src/aead.wac";
import { aesEncrypt, aesDecrypt } from "../../crypto/src/aes.wac";
import { aesCtr } from "../../crypto/src/aesctr.wac";
import { gcmEncrypt, gcmTag, gcmDecrypt } from "../../crypto/src/aesgcm.wac";
import { x25519, x25519Base } from "../../crypto/src/x25519.wac";
import { ed25519Sign, ed25519Verify, ed25519PublicKey } from "../../crypto/src/ed25519.wac";

u8[] digest = sha256(msg);                     // 32 bytes
u8[] tag    = hmacSha256(key, msg);            // 32 bytes
u8[] okm    = hkdf(salt, ikm, info, 64);       // any length
u8[] kek    = bcryptPbkdf(pass, salt, 48, 16); // OpenSSH private-key encryption
u8[] ct     = chacha20(key, 1, nonce, msg);    // same call decrypts

u8[] sealed = aeadEncrypt(key, nonce, msg);
u8[] tag    = aeadTag(key, nonce, aad, sealed);
u8[] opened = aeadDecrypt(key, nonce, aad, sealed, tag);   // traps if forged

u8[] pub    = x25519Base(secret);              // 32-byte public key
u8[] shared = x25519(secret, theirPub);        // 32-byte shared secret

u8[] vk     = ed25519PublicKey(seed);          // 32 bytes
u8[] sig    = ed25519Sign(seed, msg);          // 64 bytes
bool ok     = ed25519Verify(vk, msg, sig);
```

## X25519

Curve25519 Diffie-Hellman, RFC 7748. `src/field25519.wac` is the arithmetic in
GF(2^255-19) — ten limbs alternating 26 and 25 bits, the same technique poly1305 uses
for GF(2^130-5) — and `src/x25519.wac` is the Montgomery ladder over it, transcribed
from RFC 7748 §5 in the RFC's own variable names so the two can be read side by side.

Three independent checks, because a ladder has no partial credit: the published vectors
including the 1000-iteration chain, a differential against WebCrypto's X25519 on random
keys in both directions, and the field operations against JavaScript BigInt over 270
values weighted toward limb and modulus boundaries. The field differential is what makes
this tractable to develop at all — a wrong ladder tells you only that one of two
thousand multiplications was wrong.

## Ed25519

RFC 8032, over the same field on the twisted Edwards curve. Points are kept in extended
coordinates, and the base point is derived from y = 4/5 rather than written out, so the
x-recovery is exercised on the one point everything else depends on.

Signing and verifying are tested separately rather than only round-tripped, which is not
pedantry: the first version signed all of RFC 8032's vectors correctly and failed to
verify two of the three public keys. `sqrt(-1)` had been computed one factor of two
short, which only affects point *decoding* — a path signing never takes. A sign-then-
verify test would have passed.

Roughly 120 ms per signature. The scalar multiplication is a plain 256-step
double-and-add with no windowing, which is the slowest reasonable choice and the easiest
to read against the spec.

## ML-KEM-768

`src/mlkem.wac` — FIPS 203, the post-quantum KEM formerly called Kyber. TLS 1.3 uses it
alongside X25519 in the hybrid group X25519MLKEM768, which carries a large share of real
HTTPS traffic today, so this is a deployed algorithm rather than a speculative one.

Smaller than it looks: everything is arithmetic mod q = 3329 on degree-256 polynomials,
so there is no bignum, no modular inversion and no curve with exceptional cases. Against
P-256 it is a much simpler object. The difficulty is entirely that the transform and the
sampling are silent when wrong.

The number-theoretic transform is *incomplete* — q−1 contains a 256th root of unity but
not a 512th — so X^256+1 factors into 128 quadratics and the pointwise multiply is a
degree-1 product, not a scalar one. Treating it as 256 independent products is the
mistake the structure invites, and it yields a key exchange where the two sides derive
different secrets. The 128 twiddle factors are computed, not transcribed.

**The oracle here is the strongest in the package.** WebCrypto exports an ML-KEM private
key as its 64-byte seed and FIPS 203 keygen is deterministic in it, so keygen is compared
*byte for byte* — 1184 bytes agreeing means SHA3-512, the seed split, the SHAKE128
rejection sampling, the CBD noise, the NTT, the matrix multiply and the twelve-bit
packing are all simultaneously right. Nothing weaker pins the NTT at all: it is an
internal representation, and two different transforms each work perfectly with
themselves.

## SHA-3 and SHAKE

`src/keccak.wac` — Keccak-f[1600] and the four functions FIPS 202 builds on it. Here
because ML-KEM is defined entirely in terms of them: the matrix is sampled from SHAKE128,
the noise from SHAKE256, and the key derivation uses SHA3-256 and SHA3-512. No amount of
SHA-2 substitutes.

The rho offsets and the pi permutation are *computed* from the spec's walk rather than
transcribed. FIPS 202 prints them as a 5×5 grid, and copying a grid of rotation amounts
into a flat array indexed the other way round is the classic way to produce a hash that
is wrong for every input. Deriving them is four lines and is the definition.

Two oracles, split by what exists: WebCrypto has SHA3-256 and SHA3-512 but no SHAKE,
OpenSSL 3.5.7 has all four. Between a browser engine and a C library that is a wider net
than either. `tools/openssl35.sh` builds the latter — the system OpenSSL is 3.0.13, which
predates ML-KEM — and the SHAKE test skips itself when it is absent rather than failing
over a tool the repo does not ship.

## RSA

`src/rsa.wac`, built on [bignum](../bignum/README.md) — verification only. Signing needs
the private key, and private-key RSA in a language with no constant-time story is a worse
idea than the rest of this package already is; verification touches only public values.

PKCS#1 v1.5 *and* PSS, because TLS 1.3 needs both for different things. RFC 8446 §4.4.3
forbids v1.5 in CertificateVerify — a peer must use PSS — while §4.4.2.2 allows it for
the signatures inside a certificate chain, which is how almost every certificate in the
world is signed.

The tests are mostly refusals. RSA's history is a list of verifiers that *searched* for
the padding structure instead of requiring it: Bleichenbacher's 2006 forgery worked
against implementations that parsed the DigestInfo rather than matching its bytes, and
against ones that stopped checking after finding the hash. So the DigestInfo prefix here
is a byte table to compare against, never something to parse.

About 170 ms per 2048-bit verification. `modPow` is square-and-multiply with a divmod
after each step; the exponent is public, so branching on its bits is the one place in
this package where the timing caveat genuinely does not apply.

## bcrypt_pbkdf

`src/bcryptpbkdf.wac`, on `src/blowfish.wac` — the KDF OpenSSH encrypts a private key
with, and the reason Blowfish is in a package that otherwise stops at AES. Blowfish is
here as a cost function, not as a cipher: bcrypt's value is that its key schedule rewrites
4 KB of state 129 times per hash with no parallelism available inside it, which a GPU is
far worse at than it is at SHA-512.

Three things about it are not PBKDF2, and each produces a plausible wrong answer rather
than an obvious one:

- the hash writes its output **little-endian**, against big-endian everywhere else in
  Blowfish — a bug in the original that became the standard;
- key material is written **striped**, so block *n* supplies every *stride*-th byte rather
  than a contiguous run, and getting it wrong yields the right bytes in the wrong places;
- only round 1 salts with the salt — later rounds salt with the previous round's output.

**The oracle is OpenSSH.** There is no WebCrypto equivalent and no vector I would trust
myself to transcribe, so the test derives the key for a private key that `ssh-keygen` has
actually written and decrypts it. That is stronger than a vector: the private section
opens with the same random 32-bit value twice, and since the cipher is AES-CTR a key wrong
in any bit gives an unrelated keystream, so the two agree only by a 2^-32 accident. The
embedded public key is then matched against the `.pub` file, which reaches far enough into
the stream to cover the IV as well. Run across both cipher choices, so both the striped and
the single-block output paths are covered.

The 1042 words of Blowfish tables are the fractional hex digits of pi, generated by
Machin's formula in exact integer arithmetic and checked against the three values everyone
publishes, rather than transcribed — a transcription error in 1042 constants is not
something review catches. See [The AES S-box, and a lesson about generated
tables](#the-aes-s-box-and-a-lesson-about-generated-tables) for why that is the house
style.

About 10 ms per hash at the default 16 rounds, which is the intended order of magnitude.

## P-256 and P-384

`src/fieldp.wac`, `src/weierstrass.wac`, and `src/p256.wac` / `src/p384.wac`. A different
prime and a different curve shape from Curve25519, and both differences show:

- 2^255-19 is a power of two minus a small number, so a value that overflows folds back
  as one small multiply. The NIST primes are **Solinas** primes, chosen so reduction is a
  shuffle of 32-bit words with no multiplication at all. Neither trick works for the
  other prime.
- Curve25519's Montgomery ladder needs no addition law. A short Weierstrass curve has
  one, with exceptional cases: a point plus itself needs a different formula, and a point
  plus its negation gives the identity, which has no affine coordinates. Those cases are
  most of the extra code, and each is reached by ordinary inputs.

**One implementation, two curves.** P-256 and P-384 differ in their prime, their `b`,
their order and their base point, and in nothing else — same equation, same `a = -3`,
same formulas. So `weierstrass.wac` holds the curve arithmetic once and a field element
is an array of 32-bit limbs whose *length* picks the prime: eight for P-256, twelve for
P-384. The two curve files are constants and a named API.

**The reduction is derived rather than transcribed.** FIPS 186-4 prints a table per curve
— nine terms for P-256 in D.2.3, ten for P-384 in D.2.4 — as a grid of product-word
indices to permute and add, printed most-significant-word first. Transcribing one, and
reversing it while you do, is how you get an implementation that is wrong for every
input. Instead this uses the single fact those tables are derived from:

    2^256 = 2^224 - 2^192 - 2^96 + 1        2^384 = 2^128 + 2^96 - 2^32 + 1

which is just `p` rearranged, and folds the product's top half down one word at a time.
Slightly slower than the flat table and checkable against `p` by eye. It replaced the
transcribed P-256 table, and every existing P-256 test passed unchanged — which is the
only reason to believe the derivation.

The one subtlety is the leftover: carry propagation leaves a signed multiple `k` of
2^(32n), and a negative `k` folded by subtraction can borrow, producing another negative
`k`, forever. Since `k*fold` and `k*fold + |k|*p` are congruent, a negative `k` is folded
as `|k| * (p - fold)` instead — positive, because `0 < fold < p` for both primes.

Checked against BigInt for the field and WebCrypto for ECDH and ECDSA, in both
directions. ECDSA is randomised, so "our signatures verify in WebCrypto" is a separate
test from "we verify theirs" — there is no byte-identity to compare, unlike Ed25519.

P-384 exports verification only; there is no P-384 key exchange in this stack and signing
would need a use for it. Its tests are aimed at the generalisation rather than at a second
implementation: if twelve limbs work as well as eight, the shared code is genuinely
generic.

Roughly 37 ms per P-256 scalar multiplication.

A caller checking for the all-zero shared secret, as RFC 7748 §6.1 permits, gets it: a
low-order point multiplies to the identity and encodes as zero. This package does not
reject those itself, because whether that is an error depends on the protocol above.

## Status

| Piece | Spec | State |
|---|---|---|
| SHA-256 | FIPS 180-4 | done |
| SHA-512, SHA-384 | FIPS 180-4 | done |
| HMAC-SHA-256 | RFC 2104, FIPS 198-1 | done |
| HKDF-SHA-256 | RFC 5869 | done, extract and expand separately |
| ChaCha20 | RFC 8439 | done, 32-bit counter / 96-bit nonce |
| Poly1305 | RFC 8439 | done, 26-bit limbs |
| ChaCha20-Poly1305 | RFC 8439 §2.8 | done |
| AES-128/192/256 | FIPS 197 | done, encrypt and decrypt |
| AES-CTR | SP 800-38A | done, full 128-bit counter |
| GHASH | SP 800-38D §6.4 | done |
| AES-GCM | SP 800-38D | done, any IV length |

Everything the suite set out to cover is here.

### GHASH, and testing field arithmetic without vectors

GF(2^128) multiplication is where GCM hides. The bit order is reversed from the
obvious one — the *most* significant bit of the first byte is the coefficient of
x^0 — which is why the reduction constant appears as `0xE1...` at the top of the
high word rather than `0x87` at the bottom of the low word.

After the S-box, the lesson was that spot values do not catch a subtly wrong
table, and the same applies to a subtly wrong field. So GHASH is checked
*algebraically*, on properties no single vector can fake:

- **bilinear**: `H·(X ⊕ Y) = H·X ⊕ H·Y`, over 300 random triples
- **has the right identity**: `0x80 00…00` is 1 in this bit order
- **commutative**: `A·B = B·A`

Any of those fails immediately if the reduction constant or the bit order is
wrong, and they exercise the reduction path far more than a vector list does.

### The branch a test suite cannot reach

GCM's counter increments only the low 32 bits and *wraps* there; a carry into the
upper 96 bits would be wrong. Reaching that through `gcmEncrypt` needs 2^32
blocks, so it is unreachable in a test — and a mutation that carries all 128 bits
passed every other test in the package.

`gcmInc32` is therefore exported purely so the wrap can be pinned directly. That
is a real trade — an internal in the public surface — taken because the
alternative is an untested branch in security code of exactly the kind that is
wrong in real implementations.

### The AES S-box, and a lesson about generated tables

The S-box is generated from its definition (inverse in GF(2^8), then the affine
map) rather than transcribed, for the same reason SHA-512's constants are: 256
values is well past where a typo and a bug look alike.

The generator was wrong on the first attempt. Exactly one entry — S[0x01] — came
out as 0x63 instead of 0x7c, because an index into the antilog table needed to be
taken modulo 255 and only the input 1 reaches that case. Three spot checks
(0x00, 0x53, 0xFF) all passed straight over it.

The result was a cipher that was *right for most inputs and wrong for some*:
AES-128 matched 5 of 8 random vectors against WebCrypto. That is the worst way
for a cipher to be wrong, and a fixed-vector test can easily miss it — FIPS
197's C.1 happened to pass.

What catches it is a structural invariant rather than more spot values. The
generator now asserts the table is a permutation of 0..255 and that it is
mutually inverse with INV_SBOX, either of which fails immediately on a single
wrong entry.

### What SHA-512 is for

It is SHA-256 in 64 bits — same compression shape, wider words, 80 rounds, a
128-byte block, different rotation amounts. It earns its place as much for
exercising `u64` end to end as for the algorithm, and it did: writing it beside
SHA-256 surfaced two compiler bugs, one of them serious.

Both files declare private helpers called `rotr`, `ch` and `maj`, at 32 and 64
bits. The compiler resolved a bare function name through a global map, so
SHA-512's calls bound to SHA-256's functions. Differing widths turned that into
a wasm validation failure; at equal widths it would have been a wrong answer
with no error at all. `~` on a `u64` also emitted the 32-bit instruction. Both
are fixed upstream with regression tests.

SHA-384 is not a truncated SHA-512 — the initial state differs precisely so one
is not a prefix of the other, and a test asserts exactly that.

### Poly1305 and limbs

Poly1305 works modulo 2^130 − 5, so it needs multi-word arithmetic. The split is
five limbs of 26 bits, and the reason is arithmetic rather than taste: the
multiply forms five sums of five limb products with a factor of 5 on the folded
terms, so the widest accumulator reaches 5 · (2^26−1)² · 5 ≈ 1.1e17 against a
u64's 1.8e19 — about 164× of headroom, which is what allows carries to be
deferred to the end of the multiply instead of propagated inside it. 32-bit
limbs would not work: two of those fill a u64 exactly, leaving nothing to sum
into.

It is the one part of this package that needs `u32` and `u64` *together*, and
several steps depend on unsigned semantics directly — the borrow detection is
`(g4 >> 31) - 1` relying on both a logical shift and the wrap of 0 − 1 to
all-ones.

## Why these read the way they do

These algorithms are *defined* in unsigned terms — rotate, logical shift right,
addition modulo 2^32 — so with `u32` they transcribe almost line for line from
the standards. Written over `i32` the same code needs `>>>` for every rotate and
care at every comparison, and it is no longer obviously the spec. ChaCha20 is
the clearest case: no tables, no field arithmetic, just sixteen `u32` words.

Two places wac's shape shows through:

- **No module-level constants.** SHA-256's 64 round constants come from a
  function that builds an array. It is called once per digest rather than once
  per block, or a long message would rebuild the table every 64 bytes.
- **No multiple returns and no out-parameters.** ChaCha20's quarter round takes
  four *indices* into the state array rather than four words, because the array
  is the only way to hand four values back.

## Testing

**Most of the suite is written in wac**, in `test/wac/`, with the host supplying
only what it must — see [`wactest`](../wactest/) for the shapes that takes. What
remains in a `.test.ts` is there for one of three reasons, each stated in the
file:

- **it asserts a refusal.** A rejection here is a `trap`, and a trap unwinds the
  module rather than returning, so only the host can catch one. Every remaining
  TypeScript file in this package is refusals and nothing else.
- **it needs an outside reference to see a wrong *representative*.** The field
  differentials against BigInt — `field25519`, `p256`, `p384`, `rsa`'s modPow.
  A value congruent to the right one satisfies every relation the arithmetic can
  state about itself, so no in-language property reaches it. `field25519.wac`'s
  laws, its modulus anchors and forty boundary values all pass when the carry is
  one pass short; BigInt catches it on the first comparison.
- **it is too slow to pay on every run**, like X25519's thousand-iteration
  vector.

Two oracles, because one is not enough.

**The host.** `node:crypto` rather than WebCrypto, because a wasm call cannot
await a promise and node's equivalents are synchronous — which is what lets them
be passed into a wac test as a callback. It does SHA-2, HMAC, AES, ChaCha20-Poly1305,
SHA-3 and SHAKE, X25519, Ed25519, ECDSA and RSA, so those are compared
against it over every message length through two blocks, over key lengths that
straddle the 64-byte block boundary, and over random inputs. That covers far
more ground than a vector list, and catches padding mistakes at 55/56/63/64
bytes where they hide.

**The published vectors.** FIPS 197 appendices B and C for AES at all three key
sizes, SP 800-38A F.5.1 for CTR, the McGrew–Viega GCM cases 1–6, NIST for SHA-256 and SHA-512 including the
million-`a` case for both,
RFC 4231 for HMAC including the 131-byte key that forces the hash-the-key path,
RFC 5869 for HKDF including the empty-salt case, RFC 8439 for ChaCha20, Poly1305
and the full AEAD worked example. These matter because an oracle sharing a bug
would hide it, and because ChaCha20 and Poly1305 have no host implementation to
compare against at all.

**A BigInt reference**, for Poly1305 specifically. Its whole difficulty is the
limb arithmetic, and none of that exists when the modular arithmetic can just be
written down — so `test/poly1305.test.ts` carries a transparently-correct
reference and fuzzes the fast version against it over 400 random key/message
pairs plus saturated all-ones inputs, which is where carries propagate the full
width and the final conditional subtract fires. Fixed vectors leave most of
those paths untouched. This also caught a mis-transcribed expected value: one
hand-typed vector disagreed, and the implementation was right.

**Properties, in wac** (`test/wac/crypto_test.wac`). A vector proves one input
maps to one output; it says nothing about whether the construction depends on
everything it should. These check that a one-bit input change moves most of the
digest, that padding binds the message length, that HMAC depends on its key and
takes a different path at 64 versus 65 bytes, that ChaCha20's counter changes
the keystream and decryption undoes encryption, and that HKDF binds `info` and
produces a prefix-stable expansion.

For the AEAD the tamper cases carry the weight: an implementation that encrypts
correctly but authenticates nothing passes every round-trip test. Flipping a bit
in the ciphertext, the associated data, the tag, the key or the nonce is
rejected, as is a truncated ciphertext and a short tag — and moving a byte
across the aad/ciphertext boundary, which is exactly what the trailing length
fields in the MAC input exist to prevent.

WebCrypto has no raw block cipher, but AES-CTR with counter block B over an
all-zero plaintext returns E(B) — so the host is an oracle for the primitive
itself, not only for the mode. It does implement AES-GCM, so that whole
construction is compared against it across key sizes, AAD sizes and message
lengths — but only at a 96-bit IV, since WebCrypto rejects every other length.
The GHASH-derived `J0` path therefore has no host oracle and rests on the
published 64-bit and 480-bit IV vectors.

Verified by mutation. In GHASH and GCM: the reduction constant `0xE1` → `0x87`
fails 4 tests, reversing the bit order in the low word 6, masking the tag with
`E(inc32(J0))` instead of `E(J0)` four, a length field in bytes rather than bits
4, and the counter carrying past 32 bits 2 — that last one caught *nothing*
until the test above was added, which is why it is there. In AES: the GF
reduction polynomial 0x1B → 0x1D fails 6 tests, swapped MixColumns coefficients 7, ShiftRows off by one 7, AES-192's
round count 12 → 11 four, and the Rcon index off by one 6. Changing one SHA-256
rotation constant from 25 to 26 fails 11 tests; one ChaCha20 quarter-round rotate from 7 to 8 fails 4. In Poly1305:
the fold factor 5 → 4 fails 5, a loosened clamp mask fails 5, the high bit at
the wrong limb position fails 6, and the borrow-detect shift 31 → 30 fails 4 —
with a no-op edit failing none, so those are measuring behaviour rather than
broken compilation.

## Side channels

`test/constanttime.test.ts` runs each routine twice with different secrets and the same
public input, and compares the ordered sequence of **branches taken and memory indices
used**. Both matter: a secret-dependent branch is the obvious leak, and a secret-dependent
*index* has no branch at all — `SBOX[key_byte]` touches a cache line chosen by the key,
which is how AES keys have been recovered from cache timing since 2005.

| routine | events per run | result |
|---|---:|---|
| `sha256` | 1,555 | uniform |
| `chachaBlock` | 1,598 | uniform |
| `poly1305` | 139 | uniform |
| `x25519Base` | 1,620,094 | uniform |
| `ghash` | 513 | **leaks** — control flow diverges; not examined past that |
| `aesExpandKey` | 455 | **leaks** — secret-dependent index at `aes.wac:113`, `aes.wac:114`, `aes.wac:115`, `aes.wac:116` |
| `aesEncrypt` | 8,631 | **leaks** — secret-dependent index at `aes.wac:113`, `aes.wac:114`, `aes.wac:115`, `aes.wac:116`, `aes.wac:149`; control flow diverges; not examined past that |
| `bcryptPbkdf` | >4,194,304 | **not measured** — trace exceeds the compiler's event buffer, which a KDF's cost is meant to |

The x25519 row is the one worth reading twice: the ladder is uniform across every one of
1.6 million events, which is what "structurally uniform" was claiming without evidence.

**AES leaks in five places, not one.** Four are the key schedule's `SubWord` lookups
(`aes.wac:113`–`116`) and the fifth is `SubBytes` itself (`aes.wac:149`), each indexing
the S-box with a key-derived byte — index 0 for an all-zero key against 255 for an
all-ones one. Then control flow diverges at `xtime`'s conditional reduction
(`aes.wac:66`), which was not previously documented, and **nothing past that point has
been examined**: once two runs take different paths their event streams describe
different executions, so comparing them further produces noise rather than findings.

`ghash` diverges in control flow before any index does, so the same caveat applies to
everything after its multiply loop.

**`bcryptPbkdf` is the one row that is not a result.** The tracer records every branch and
memory index into a buffer of 2^22 events, which lives in the compiler and is not this
package's to raise; a single bcrypt hash is 129 full Blowfish key expansions and no
parameter brings it under, since being expensive is the entire point of the function. So
the honest entry is that it was not measured — see wac issue 0059.

What can be said without measuring: it leaks, by construction rather than by accident.
Blowfish's round function indexes four S-boxes with state derived from the password, and
bcrypt then rewrites those S-boxes from the password 129 times over. Cache-timing
resistance was never among its goals, and a version that had it would not be bcrypt.

Regenerate this table with `deno run -A packages/crypto/ct.ts`. It is generated rather
than hand-written because published figures that cannot be reproduced go stale silently —
which is what `issues/open/0007` is about.

**What a uniform result does not mean.** The check is dynamic, so it covers the key pairs
tested and no others; it is wasm-level, so identical operations can still take different
time on hardware — `i64.div_s` latency depends on its operands, and the engine and CPU do
as they please; and it says nothing about values written, only about branches and
addresses. It is a necessary condition, not a sufficient one. A *failure* is definite.

**A static check was considered and declined** (2026-08-01). A `secret` qualifier on a
parameter, propagated by the type checker and refused at a branch or an index, would
cover every path rather than the inputs tested. It also needs declassification — a
ciphertext is key-derived and must become public somewhere — and an over-taint story, and
it wants the same machinery as putting `const` in the type. Not worth it for a package
that is not for production: the dynamic check finds the leaks that get written.

**Fixing the index leak** means removing the table, not moving it: either scan every entry
and select with an arithmetic mask (`0 - (i == want)` is all-ones or zero, no branch),
which costs O(n) per lookup, or bitslice the S-box so there is no table to index. wac does
not optimise, so a masked select survives compilation intact — which is the one place the
compiler being simple is a security property.
