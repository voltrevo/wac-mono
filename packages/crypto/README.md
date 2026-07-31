# crypto

SHA-256, HMAC, HKDF and ChaCha20, written in wac.

A package of [wac-mono](../../README.md) — see the root README for layout and how
to run things. All commands run from the repo root.

```wac
import { sha256 } from "../../crypto/src/sha256.wac";
import { hmacSha256 } from "../../crypto/src/hmac.wac";
import { hkdf } from "../../crypto/src/hkdf.wac";
import { chacha20 } from "../../crypto/src/chacha20.wac";

u8[] digest = sha256(msg);                     // 32 bytes
u8[] tag    = hmacSha256(key, msg);            // 32 bytes
u8[] okm    = hkdf(salt, ikm, info, 64);       // any length
u8[] ct     = chacha20(key, 1, nonce, msg);    // same call decrypts
```

## Status

| Piece | Spec | State |
|---|---|---|
| SHA-256 | FIPS 180-4 | done |
| HMAC-SHA-256 | RFC 2104, FIPS 198-1 | done |
| HKDF-SHA-256 | RFC 5869 | done, extract and expand separately |
| ChaCha20 | RFC 8439 | done, 32-bit counter / 96-bit nonce |

Not here: SHA-512, Poly1305 and therefore the ChaCha20-Poly1305 AEAD, and AES.
Poly1305 is the interesting one — it needs arithmetic modulo 2^130 − 5, which
means limbs, and is the first thing in this package that the language does not
already fit.

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
RFC 5869 for HKDF including the empty-salt case, RFC 8439 for ChaCha20. These
matter because an oracle sharing a bug would hide it, and because ChaCha20 has
no host implementation to compare against at all.

**Properties, in wac** (`test/wac/crypto_test.wac`). A vector proves one input
maps to one output; it says nothing about whether the construction depends on
everything it should. These check that a one-bit input change moves most of the
digest, that padding binds the message length, that HMAC depends on its key and
takes a different path at 64 versus 65 bytes, that ChaCha20's counter changes
the keystream and decryption undoes encryption, and that HKDF binds `info` and
produces a prefix-stable expansion.

Verified by mutation: changing one SHA-256 rotation constant from 25 to 26 fails
11 tests, and changing one ChaCha20 quarter-round rotate from 7 to 8 fails 4.

## Not for production

Nothing here is constant-time. Comparisons short-circuit, and the compiler is
free to reorder as it likes. Do not use this where timing is observable to an
attacker.
