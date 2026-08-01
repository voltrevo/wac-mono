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
| `host/serve.ts` | the socket and the randomness, which wasm does not have |

## Run it

```sh
deno run -A packages/tls/host/serve.ts 8443

openssl s_client -connect 127.0.0.1:8443 -tls1_3 -servername wac.test
curl --noproxy '*' --cacert packages/tls/test/data/ca.pem \
     --resolve wac.test:8443:127.0.0.1 https://wac.test:8443/
```

Three clients complete the handshake today: OpenSSL 3.0, rustls (through Deno's TLS
client, which also verifies the certificate chain) and curl. The first two run in
`test/handshake_interop.test.ts` on every `deno task test`.

## What works

TLS_AES_128_GCM_SHA256 and TLS_CHACHA20_POLY1305_SHA256, X25519 key exchange, Ed25519
server certificates. Full 1-RTT handshake, application data both ways, and the
compatibility fields — the legacy version, the echoed session id, the meaningless
ChangeCipherSpec — that middleboxes need to see.

## What is missing

No PSK or session resumption, no 0-RTT, no HelloRetryRequest, no client certificates,
no session tickets, no key update, no `close_notify` on shutdown, and no client side at
all. Each is a real part of TLS 1.3; the server refuses rather than pretending.

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
