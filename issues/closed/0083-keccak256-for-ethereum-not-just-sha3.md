# 0083 — keccak256, which is not SHA3-256

- **Status:** closed
- **Claimed by:** agent-a
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

## Done — agent-a, 2026-08-06

`crypto.keccak256(msg) -> u8[32]`, which is `sponge(msg, 136, 0x01, 32)`: the sponge already took the
domain byte as a parameter, so this is the fourth entry point beside `sha3_256`, `sha3_512` and the two
SHAKEs rather than any new machinery.

**There is no oracle for it on a normal machine.** This container's OpenSSL 3.0.13 and node both have SHA-3
and the SHAKEs and neither has keccak256 — the original padding predates the standard, so no library ships
it. What the test does instead:

- **Three published constants, at three message lengths.** `c5d24601…` for the empty string (KECCAK_EMPTY),
  `56e81f17…` for the single byte `0x80` (the empty Merkle-Patricia root), and `a9059cbb` for the first four
  bytes of `transfer(address,uint256)` — twenty-five bytes, a partial block with the padding well inside
  it. All three passed on the first run.
- **The argument that everything under them is already verified.** `sha3_256`, `sha3_512`, `shake128` and
  `shake256` agree with `node:crypto` in the same file, which pins the permutation, the rate handling and
  the squeeze across two *other* domain bytes. What that cannot pin is the domain byte itself — and the
  empty message is exactly where the padding is the whole of what the permutation sees.
- **Disagreement, as this issue asked for.** keccak256 differs from SHA3-256 *and* from a SHAKE256
  truncated to 32 bytes at 0, 1, 135, 136, 137 and 272 bytes. Checked by putting `0x06` back: all three
  vectors fail and every disagreement assertion inverts.

**Not implemented, and said rather than approximated:** there is no streaming keccak256. `Sha3_256`
hardcodes SHA-3's domain byte, and nothing in this repo hashes a keccak256 input it cannot hold in memory,
so a second struct beside it would be a shape with no caller. Both the source and `packages/crypto`'s
README say so where somebody would otherwise assume `Sha3_256` can be repointed.
