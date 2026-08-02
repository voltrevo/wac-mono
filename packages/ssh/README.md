# ssh

An SSH-2 client, in wac. **Transport layer only so far** — version exchange, the binary packet
protocol, and algorithm negotiation. No key exchange, no encryption, no authentication yet.

> **Not for production**, for the same reason [crypto](../crypto/README.md) is not: it is built on
> primitives that are known to leak timing, and nothing here has been reviewed by anyone.

A package of [wac-mono](../../README.md) — see the root README for layout and how to run things.
All commands run from the repo root.

## What works

```
deno task test packages/ssh
deno task coverage:ssh
```

The test that matters runs a real `sshd`, performs the version exchange and the KEXINIT exchange
against it, and negotiates. Everything else in the suite pins a rule; that one says the rules were
read correctly. A server that dislikes anything about our framing closes the connection rather
than answering, so a parsed server KEXINIT means the packet layer is right in both directions.

Against OpenSSH 9.6 it negotiates `curve25519-sha256`, `ssh-ed25519` and
`chacha20-poly1305@openssh.com` — which is what the next slice has to implement.

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

## What is missing

In the order it is needed:

1. **Key exchange** — `curve25519-sha256`, the exchange hash, and `ssh-ed25519` host key
   verification. [crypto](../crypto/README.md) already has `x25519` and `ed25519`.
2. **The cipher** — `chacha20-poly1305@openssh.com`. Not the RFC 8439 AEAD: two keys, the length
   field encrypted separately, and the MAC over the ciphertext. Buildable from `chacha20` and
   `poly1305`, and the easiest thing here to get subtly wrong.
3. **Authentication** — `publickey` with ed25519. Encrypted private keys are already readable;
   `bcrypt_pbkdf` landed in crypto for this.
4. **The connection protocol** — channels, window adjustment, `exec`.

`known_hosts` is a byte comparison against the host key blob, so there is no X.509 and no chain
building — which is the main reason this is a smaller job than the TLS client already in the repo.
