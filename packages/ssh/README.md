# ssh

An SSH-2 client, in wac. **It logs in.** Version exchange, the binary packet protocol, algorithm
negotiation, curve25519-sha256 key exchange, `ssh-ed25519` host key verification, the
`chacha20-poly1305@openssh.com` AEAD, reading an OpenSSH private key — encrypted or not — and
publickey authentication. No channels yet, so it cannot run anything.

> **Not for production**, for the same reason [crypto](../crypto/README.md) is not: it is built on
> primitives that are known to leak timing, and nothing here has been reviewed by anyone.

A package of [wac-mono](../../README.md) — see the root README for layout and how to run things.
All commands run from the repo root.

## What works

```
deno task test packages/ssh
deno task coverage:ssh
```

The test that matters runs a real `sshd`, performs the version, KEXINIT and key exchanges
against it, and **verifies the server's host key signature over our own exchange hash**.
Everything else in the suite pins a rule; that one says the rules were read correctly.

It is a hard pass or fail, and it covers almost everything at once: the signature verifies only
if every input to the exchange hash matches what the server used — both version strings without
their line endings, both KEXINIT payloads byte for byte as sent, the host key blob, both
ephemeral public keys, and the shared secret in its mpint form. One wrong byte anywhere and
Ed25519 verification fails. The test then checks the host key is the one in `hostkey.pub`, since
a signature that verifies against a key the server also chose proves only self-consistency, and
bends a bit of H to confirm verification actually fails when it should.

It then sends NEWKEYS, derives the traffic keys, and carries on **encrypted**: an encrypted
SERVICE_REQUEST goes out and the server's EXT_INFO and SERVICE_ACCEPT come back and decrypt. That
covers the whole transport in both directions at once — a wrong key half, counter, padding rule
or sequence number and the server drops the connection rather than replying.

It then reads the client private key with its own code, signs the authentication request, and
receives `SSH_MSG_USERAUTH_SUCCESS`. So the single interop test covers the protocol from the
first byte to a logged-in session.

Against OpenSSH 9.6 it negotiates `curve25519-sha256`, `ssh-ed25519` and
`chacha20-poly1305@openssh.com`.

## Why the pieces look like this

**`wire.wac`** — the six types of RFC 4251 §5. Two of them carry the mistakes:

`string` is arbitrary binary with a `uint32` length, not a C string. Host keys, signatures and the
whole key exchange are strings nested inside strings, and a reader that stops at a zero byte
truncates them silently.

`mpint` is *signed*. Leading zero bytes are stripped, and then a zero byte is added back when the
top bit of what remains is set — without which a 2048-bit RSA modulus reads as negative. Zero is
an empty string rather than one zero byte.

Reading never traps. A remote peer chooses every length on the wire, so running off the end is an
expected answer and not an internal error: `Reader.ok` latches false and every later read is a
no-op, so a caller parses a whole message and checks once at the end. A length with the top bit
set arrives in a signed `i32` as negative, which is refused rather than clamped — otherwise the
bounds check is asked for a negative count and waves it through.

**`packet.wac`** — the binary packet protocol, RFC 4253 §6. The length field is *inside* the
encryption, which is why a reader cannot know how much to read before decrypting, and why
`chacha20-poly1305@openssh.com` carries a separate key just for the length. Nothing is encrypted
yet; this is the shape the cipher slots into.

Padding is mandatory, at least 4 bytes, random, and sized so the whole packet *including the
4-byte length field* is a multiple of the cipher block size. Sizing it to align everything except
the length produces packets a server accepts until encryption starts and then rejects.

The randomness comes from the caller, because wac cannot ask the host for entropy — the same
arrangement [tls](../tls/README.md) uses.

**`version.wac`** — the line each side sends before framing exists. A server may send any number
of banner lines first, and a client that reads exactly one line works against every server that
has no banner, which during development is all of them. The CR LF is *not* part of the version
string: both versions go into the exchange hash without their line endings, and including them
produces a signature that verifies against nothing, far enough from here that the cause is not
obvious.

**`kex.wac`** — the exchange itself, and the key derivation of RFC 4253 §7.2. The exchange hash
H is the security of the whole protocol in one value: the server signs it, so a peer that cannot
produce that signature cannot have chosen any of its inputs, which is what stops an attacker in
the middle from downgrading the algorithm lists.

**K is an mpint, not 32 bytes.** The X25519 output is read as an unsigned big-endian integer and
encoded minimally, so a secret starting with a zero byte is 31 bytes on the wire and one with its
top bit set gains a leading zero. Each happens about one time in 256 — often enough to be a real
bug, rarely enough that a client written the obvious way works for a while first.

Key derivation extends by hashing **everything produced so far**, not just the previous block.
That only shows up above one hash length, and the only key we need that is longer is
chacha20-poly1305's 64 bytes, so nothing else in the protocol would catch it. Checked against a
transcription of the RFC using WebCrypto.

An all-zero shared secret means the peer sent a low-order point and every session would share the
same secret; RFC 8731 §3 requires aborting, and nothing later notices if you do not.

**`cipher.wac`** — `chacha20-poly1305@openssh.com`, which is **not** the RFC 8439 AEAD that
`crypto/src/aead.wac` implements. Same two primitives, every structural choice different:

Two keys, from 512 bits of key material — and the *first* 256 are K_2, the second K_1, which
reads backwards. K_1 encrypts only the 4-byte packet length; K_2 encrypts the payload and keys the
MAC. Swapping them round-trips perfectly against itself and fails only against a real server,
which is why there is a test asserting the halves are not interchangeable.

The length is encrypted under its own key so a reader can learn how much to read without having
decrypted anything it must then trust. The MAC covers the ciphertext — both the encrypted length
and the encrypted body — and is checked *before* anything is decrypted. None of RFC 8439's
associated-data framing appears: the MAC input is simply the bytes on the wire.

The nonce is the packet sequence number and nothing else, so the `A`/`B` and `E`/`F` key
derivation outputs go unused. The sequence number is never transmitted; both sides count, and if
they ever disagree the MAC fails with no indication of why. Strict KEX resets both counters at
NEWKEYS, which is the one place that is easy to get wrong and impossible to debug from the
symptom.

Padding here follows the **AEAD rule, not RFC 4253's**: because the length is authenticated
separately, only `padding_length || payload || padding` is aligned, not the whole packet. The two
differ by exactly 4 bytes for every length, so a test that checks "aligned to something" passes
with either.

**`kexinit.wac`** — negotiation, RFC 4253 §7.1. The rule is asymmetric: the chosen algorithm is
**the client's first preference that the server also supports**. Server order is ignored. Getting
that backwards yields a client that negotiates something plausible and disagrees with the server
about what was negotiated, which surfaces much later as a MAC failure.

The proposal is deliberately narrow — one key exchange, one host key type, one cipher — because
advertising something we cannot perform is worse than not advertising it: the server will pick it.
Two entries are not algorithms. `ext-info-c` asks for the server's extension list, which is how a
client learns `rsa-sha2-256` is available rather than the SHA-1 that `ssh-rsa` implies.
`kex-strict-c-v00@openssh.com` opts in to strict KEX, which forbids the unrelated messages the
Terrapin attack (CVE-2023-48795) used to shift sequence numbers.

**`privatekey.wac`** — the `openssh-key-v1` file format, which is not PKCS#8 and not PEM RSA.
`none` and `aes256-ctr`+`bcrypt` are read; anything else is refused by name rather than misread.

**There is no MAC over the private section.** A wrong passphrase decrypts to plausible random
bytes, and the *only* thing that notices is a random 32-bit value stored twice at the front
failing to match itself. That is a 2^-32 false accept by design, and it means the check cannot be
skipped — everything after it would otherwise be parsed out of noise. The private string is the
32-byte seed followed by the public key again; only the first half is secret.

**`auth.wac`** — publickey authentication, RFC 4252 §7. The signature covers **the session
identifier followed by the request without its signature field**, and the session id is what makes
it worth anything: without it a signature is a bearer token that a malicious server could collect
and replay to a third party as the client. The session id is length-prefixed as a `string` even
though nothing follows that could be confused with it — omitting that length produces a signature
the server rejects, indistinguishable from the key being wrong.

## What is missing

In the order it is needed:

1. **The connection protocol** — channels, window adjustment, `exec`. That is what turns a
   logged-in connection into one that can run a command.

Also absent, and worth naming rather than leaving implied: `known_hosts` is not consulted, so the
host key is verified as *self-consistent* but not as *expected* — the interop test compares it
against the file it generated, which a real client cannot do. Rekeying is not implemented. Neither
is any authentication method other than publickey with Ed25519.

`known_hosts` is a byte comparison against the host key blob, so there is no X.509 and no chain
building — which is the main reason this is a smaller job than the TLS client already in the repo.
