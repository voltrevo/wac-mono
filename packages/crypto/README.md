# crypto

SHA-256, HMAC, HKDF, ChaCha20, Poly1305 and the ChaCha20-Poly1305 AEAD,
written in wac.

A package of [wac-mono](../../README.md) — see the root README for layout and how
to run things. All commands run from the repo root.

```wac
import { sha256 } from "../../crypto/src/sha256.wac";
import { hmacSha256 } from "../../crypto/src/hmac.wac";
import { hkdf } from "../../crypto/src/hkdf.wac";
import { chacha20 } from "../../crypto/src/chacha20.wac";
import { aeadEncrypt, aeadTag, aeadDecrypt } from "../../crypto/src/aead.wac";

u8[] digest = sha256(msg);                     // 32 bytes
u8[] tag    = hmacSha256(key, msg);            // 32 bytes
u8[] okm    = hkdf(salt, ikm, info, 64);       // any length
u8[] ct     = chacha20(key, 1, nonce, msg);    // same call decrypts

u8[] sealed = aeadEncrypt(key, nonce, msg);
u8[] tag    = aeadTag(key, nonce, aad, sealed);
u8[] opened = aeadDecrypt(key, nonce, aad, sealed, tag);   // traps if forged
```

## Status

| Piece | Spec | State |
|---|---|---|
| SHA-256 | FIPS 180-4 | done |
| HMAC-SHA-256 | RFC 2104, FIPS 198-1 | done |
| HKDF-SHA-256 | RFC 5869 | done, extract and expand separately |
| ChaCha20 | RFC 8439 | done, 32-bit counter / 96-bit nonce |
| Poly1305 | RFC 8439 | done, 26-bit limbs |
| ChaCha20-Poly1305 | RFC 8439 §2.8 | done |

Not here: SHA-512 and AES.

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

Two oracles, because one is not enough.

**The host.** WebCrypto does SHA-256, HMAC and HKDF, so those are compared
against it over every message length through two blocks, over key lengths that
straddle the 64-byte block boundary, and over random inputs. That covers far
more ground than a vector list, and catches padding mistakes at 55/56/63/64
bytes where they hide.

**The published vectors.** NIST for SHA-256 including the million-`a` case,
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

Verified by mutation. Changing one SHA-256 rotation constant from 25 to 26 fails
11 tests; one ChaCha20 quarter-round rotate from 7 to 8 fails 4. In Poly1305:
the fold factor 5 → 4 fails 5, a loosened clamp mask fails 5, the high bit at
the wrong limb position fails 6, and the borrow-detect shift 31 → 30 fails 4 —
with a no-op edit failing none, so those are measuring behaviour rather than
broken compilation.

## Not for production

Nothing here is constant-time. Comparisons short-circuit, and the compiler is
free to reorder as it likes. Do not use this where timing is observable to an
attacker.
