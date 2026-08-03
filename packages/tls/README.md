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
| `src/x509.wac` | certificate parsing, path building, chain and host-name verification |
| `src/client.wac` | the client state machine |
| `src/hybrid.wac` | X25519MLKEM768, the post-quantum hybrid key agreement |
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

Both ends. TLS_AES_128_GCM_SHA256 and TLS_CHACHA20_POLY1305_SHA256; **X25519MLKEM768**,
X25519 and secp256r1 key exchange; and Ed25519, ECDSA-P256, ECDSA-P384 and RSA
certificates.

X25519MLKEM768 is the post-quantum hybrid from
[draft-ietf-tls-ecdhe-mlkem](https://datatracker.ietf.org/doc/html/draft-ietf-tls-ecdhe-mlkem),
offered first by the client and preferred by the server. Both ends negotiate it with
OpenSSL 3.5.7 configured to accept nothing else, which is in the suite.

The concatenation order is the part worth knowing: X25519MLKEM768 puts ML-KEM first and
SecP256r1MLKEM768 puts the ECDHE half first. Two hybrids in one document, ordered
differently — a fact about the registry rather than a principle, and precisely the sort
of thing a reader assumes is consistent. It was taken from the draft and then confirmed
against a real ClientHello, which offers 1216 bytes for this group. Full 1-RTT handshake, application data both ways, alerts,
close_notify, KeyUpdate, and the compatibility fields — the legacy version, the echoed
session id, the meaningless ChangeCipherSpec — that middleboxes need to see.

The client verifies three things before it sends a byte, and refuses if any fails: a
path from the leaf, through whatever intermediates the server sent, to a root in the
trust store it was given, in date and covering the name asked for; the CertificateVerify
signature, binding that identity to *this* transcript; and the server's Finished. Each
refusal has its own test, paired with the connection that must still succeed — a client
that refuses everything passes every rejection test.

### It reaches the actual web

`host/connect.ts` points the client at a real host with the system trust store:

```
deno run -A packages/tls/host/connect.ts github.com 443
```

which returns `HTTP/1.1 200 OK` from github.com, having built and verified the path
against `/etc/ssl/certs/ca-certificates.crt` — 121 roots, none of them fixtures.

Two real chains, two shapes, and both were needed to find the gaps. github.com is
leaf → Sectigo E36 → **Sectigo Public Server Authentication Root E46**: every certificate
below the top is P-256, and the root is P-384. A client without P-384 parses the whole
chain, walks the path all the way up, and then reports "unknown authority" about a root
sitting right there in the store — which is what happened, and is why P-384 exists here.
raw.githubusercontent.com is the other shape: leaf → Let's Encrypt YR2 → ISRG Root YR
**cross-signed by ISRG Root X1**, where the anchor is three certificates up and the last
certificate the server sends is not in the store at all. Anything that assumes the chain
ends at a root fails that one.

It offers both key shares in its first flight rather than one. That costs about a
hundred bytes and saves a whole round trip when a server prefers P-256, which matters
because this client cannot answer a HelloRetryRequest.

Three certificate types, three encoding quirks, each a place a parser is right for two
and wrong for the third:

| type | the quirk |
|---|---|
| Ed25519 | the key is the BIT STRING and that is all |
| ECDSA | the *curve* is in the algorithm parameters, not the key — ignore them and a P-384 key reads as P-256. The parameters use a different OID arc for each curve: P-256 is under ANSI's 1.2.840.10045, P-384 only ever got registered by SECG under 1.3.132 |
| RSA | the modulus is a DER INTEGER, so one with its top bit set carries a leading zero that is not part of the key |

And ECDSA signatures arrive as a SEQUENCE of two INTEGERs that must be unwrapped and
zero-padded back to the curve's width — 32 bytes for P-256, 48 for P-384. A shorter `r`
is not a smaller signature, it is the same number with fewer digits.

The hash and the curve are independent, too. `ecdsa-with-SHA384` says nothing about which
curve signed it, and a P-384 key signing with SHA-256 is legal and occurs; the hash comes
from the signature algorithm and the curve from the *signer's key*. Pairing them the
other way round verifies every chain where they happen to agree, which is most of them.

## What is missing

No PSK or session resumption, no 0-RTT, no HelloRetryRequest, no client certificates
and no session tickets. Each is a real part of TLS 1.3; both sides send an alert rather
than pretending.

**No backtracking in path building, and no revocation.** `tlsClientInit` takes a trust
store and the client builds a path from the leaf up through whatever intermediates the
server sent, stopping at the first root that both matches by name and verifies. A
cross-signed root arriving as an intermediate is followed like any other link. What it
does not do is try an alternative issuer when a link verifies but leads nowhere, so a
chain with two possible paths where only the second reaches a root is reported as
untrusted. There is no CRL or OCSP checking of any kind.

**No Ed448, no P-521, no RSA below SHA-256.** An unsupported algorithm leaves a
certificate's key type at zero and path building skips it, rather than trapping — the
system trust store here holds 121 roots and some use things this does not implement, and
one exotic root must not take down the parse of the other 120.

**PSS parameters are assumed, not parsed.** A certificate signed with RSASSA-PSS carries
its hash and salt length in the algorithm parameters; this assumes SHA-256 with a
matching salt, which is what certificate authorities issue. Anything else fails closed.

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

**Most of the suite is written in wac**, in `test/wac/` — the record layer, the
key schedule, the wire cursor, the hybrid, and certificate path building. The
host supplies only what it must: an AEAD or an HMAC as a synchronous callback,
or, for the certificates, a loader that hands over fixture bytes because wac
cannot read a file. See [`wactest`](../wactest/) for the shapes that takes.

What stays in TypeScript, and why:

- **the refusals.** A rejection here is a `trap`, which unwinds the module rather
  than returning, so only the host can catch one. That is most of what a record
  layer and a wire parser owe their callers, so those files are worth reading.
- **interop.** OpenSSL, rustls and curl. A live peer's next byte depends on ours,
  which is not something a vector or an invariant can express.
- **the real trust store**, which reads `/etc/ssl` and reports on 121 real roots.

## Not for production

Nothing in the dependency chain is constant-time — see [crypto's
README](../crypto/README.md). Beyond that, this has not been reviewed by anyone, has no
protection against the implementation mistakes TLS deployments spend their lives
avoiding, and exists because building it is how you find out what the packages
underneath are missing.

## Not only sockets

`TlsStream` runs over anything with `Deno.Conn`'s read/write/close, and is itself one, so it
composes both ways: TLS over a socket, TLS over a Tor stream, HTTP over either. The shape is
`Deno.Conn`'s rather than a nicer one of our own precisely so that no adapter is needed at
any boundary — a real socket satisfies it structurally, and so does anything written to
match.
