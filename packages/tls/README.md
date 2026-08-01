# tls

TLS 1.3 (RFC 8446) in wac. **Not for production** — see the note at the bottom.

A package of [wac-mono](../../README.md). All commands run from the repo root.

## What is here

| file | what |
|---|---|
| `src/keyschedule.wac` | HKDF-Expand-Label, Derive-Secret, and the secret chain (§7.1) |
| `src/record.wac` | the record layer: AEAD sealing, nonce construction, framing (§5) |

Built on [crypto](../crypto/README.md), which already had everything the record layer
and key schedule need — AES-GCM, ChaCha20-Poly1305, HKDF, SHA-256 — and gained X25519
and Ed25519 for the handshake.

## How it is tested

Two kinds of oracle, because they catch different things.

**Independent implementations.** WebCrypto decrypts records we seal, given a nonce and
additional data computed from the spec rather than from our code; an HKDF-Expand-Label
written out separately on WebCrypto's HMAC checks every label and length. A round trip
would pass with a wrong nonce, a wrong AAD, or the content type read from the wrong end
— seal and open share every constant, so they agree on any mistake they share.

**RFC 8448's trace.** The published handshake gives every intermediate secret in hex, so
the *chain* can be checked and not just the primitives: the right derivation applied to
the wrong secret produces perfectly well-formed keys shared with nobody.

Worth recording that several of those vectors were written from memory first and half of
them were wrong. They survive here only because the implementation and the independent
reference agreed against them and forced a re-check; where the two disagreed, the
recalled value was dropped rather than adjusted to fit.

## Not for production

Nothing in the dependency chain is constant-time — see [crypto's
README](../crypto/README.md). Beyond that, this has not been reviewed by anyone, has no
protection against the implementation mistakes TLS deployments spend their lives
avoiding, and exists because building it is how you find out what the packages
underneath are missing.
