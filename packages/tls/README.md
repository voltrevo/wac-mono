# tls

TLS 1.3 (RFC 8446) in wac. **Not for production** — see the note at the bottom.

A package of [wac-mono](../../README.md). All commands run from the repo root.

## What is here

| file | what |
|---|---|
| `src/keyschedule.wac` | HKDF-Expand-Label, Derive-Secret, and the secret chain (§7.1) |
| `src/record.wac` | the record layer: AEAD sealing, nonce construction, framing (§5) |
| `src/wire.wac` | big-endian length-prefixed reading and writing, bounds-checked |
| `src/handshake.wac` | handshake messages (§4) |
| `src/server.wac` | the server state machine |
| `src/asn1.wac` | a DER reader, bounds-checked and strict about what DER forbids |
| `src/x509.wac` | certificate parsing, chain and host-name verification |
| `src/client.wac` | the client state machine |
| `host/serve.ts` | the socket and the randomness, which wasm does not have |
| `host/connect.ts` | the same, for the client |

## Run it

```sh
deno run -A packages/tls/host/serve.ts 8443

openssl s_client -connect 127.0.0.1:8443 -tls1_3 -servername wac.test
curl --noproxy '*' --cacert packages/tls/test/data/ca.pem \
     --resolve wac.test:8443:127.0.0.1 https://wac.test:8443/
```

And the client, against anything that speaks Ed25519:

```sh
openssl s_server -accept 8500 -cert packages/tls/test/data/leaf.pem \
                 -key packages/tls/test/data/leaf.key -tls1_3 -www -quiet &
deno run -A packages/tls/host/connect.ts wac.test 8500 packages/tls/test/data/ca.pem
```

Three clients complete the handshake today: OpenSSL 3.0, rustls (through Deno's TLS
client, which also verifies the certificate chain) and curl. The first two run in
`test/handshake_interop.test.ts` on every `deno task test`, and one of those checks that
the shutdown is seen as a `close_notify` rather than as a truncation.

`openssl s_client -quiet` still prints "unexpected eof while reading" at the end. That is
its own stdin handling rather than a missing alert: curl exits 0 with no stderr and
rustls reads a clean end-of-stream, both of which would fail if the alert were absent or
malformed.

## What works

Both ends. TLS_AES_128_GCM_SHA256 and TLS_CHACHA20_POLY1305_SHA256, X25519 key exchange,
Ed25519 certificates. Full 1-RTT handshake, application data both ways, alerts,
close_notify, KeyUpdate, and the compatibility fields — the legacy version, the echoed
session id, the meaningless ChangeCipherSpec — that middleboxes need to see.

The client verifies three things before it sends a byte, and refuses if any fails: the
certificate chain to a root it was given, in date and covering the name asked for; the
CertificateVerify signature, binding that identity to *this* transcript; and the
server's Finished. Each refusal has its own test, paired with the connection that must
still succeed — a client that refuses everything passes every rejection test.

## What is missing

No PSK or session resumption, no 0-RTT, no HelloRetryRequest, no client certificates
and no session tickets. Each is a real part of TLS 1.3; both sides send an alert rather
than pretending.

**Ed25519 only.** The public web runs on RSA and ECDSA, so this client cannot talk to
it. Adding P-256 means a second field and ECDSA; adding RSA means bignum modular
exponentiation and PKCS#1. Both are tractable and neither is here.

**One trusted root, not a store.** `tlsClientInit` takes a single certificate. A real
client carries hundreds and has to build a path through intermediates; this checks
leaf-against-root and nothing longer.

The HelloRetryRequest gap has a visible consequence: a client offering no X25519 key
share gets `handshake_failure`, where a complete server would ask it to try again with
one. Every mainstream client offers X25519, so this is rarely hit and is still wrong.

Alerts, `close_notify` and KeyUpdate *are* handled. A peer's mistake produces the alert
RFC 8446 §6 names for it rather than a dropped connection — the difference between a
client that can report what went wrong and one that has to guess.

The certificate is presented, not parsed — a server sends a DER blob it was handed. A
client would need X.509 parsing and chain validation, which is a much larger job than
producing one.

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
