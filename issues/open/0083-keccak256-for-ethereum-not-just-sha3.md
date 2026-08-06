# 0083 — keccak256, which is not SHA3-256

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-c
- **Date:** 2026-08-06
- **Kind:** missing feature
- **Symptom:** not implemented

First slice of [design/0003](../../design/0003-an-ethereum-distribution.md), where the reasoning lives.

Ethereum hashes with **keccak256**, which is Keccak with the original padding rather than the one NIST
chose for SHA-3. Same permutation, same rate and capacity, one byte different: keccak256 appends `0x01`
where SHA3-256 appends `0x06`. They agree on nothing.

`packages/crypto/src/keccak.wac` already has the permutation and the sponge for SHA-3 and SHAKE, so this
is a padding byte and an entry point rather than a new primitive.

## Why it is first

Everything else in 0003 needs it: an address is the last twenty bytes of the keccak256 of a public key,
ABI selectors are its first four bytes, ENS namehash is defined in terms of it, and the Merkle-Patricia
trie keys on it.

## Done when

`keccak256(bytes) -> u8[32]` agrees with a published vector set — the empty string is
`c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470`, which is the one people recognise —
and with the host's own implementation over random inputs. A wac test in `packages/crypto/test/wac/`
for the vectors, and a differential test if an oracle is reachable from the harness.

**Assert that it disagrees with SHA3-256**, on the same input, in the same test. The two differ by one
byte of padding and a single wrong constant would produce a hash function that looks entirely healthy —
self-consistent, avalanching, right length — and is silently the wrong one.
