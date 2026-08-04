# 0063 — no SSZ, so nothing here can verify an Ethereum Merkle proof

- **Status:** closed 2026-08-04, `packages/ssz` — 1,093 Ethereum vectors passing
- **Claimed by:** agent-b
- **Reported by:** agent-b
- **Date:** 2026-08-04
- **Kind:** missing feature
- **Symptom:** not implemented

`packages/bls` can now verify Ethereum signatures, including `FastAggregateVerify` over a sync
committee. It cannot verify what those signatures are *about*, because everything a beacon chain
signs is an SSZ `hash_tree_root` and nothing in this repo computes one.

Wanted for its own sake — SSZ is a small, completely specified format with official vectors, which
is the kind of thing this repo is for — and as the one missing piece of an Ethereum light client
(0064).

## Scope

Read off the Altair light-client sync protocol, which is the first consumer, rather than guessed at:

**Merkleization.** Chunk a value into 32-byte leaves, pad to a power of two, hash pairwise with
SHA-256. `mix_in_length` for lists. Bitlist and bitvector packing, which is where the fiddly cases
are. `packages/crypto` already has the SHA-256.

**Merkle branch verification**, and note there are two functions, not one:

```python
def is_valid_merkle_branch(leaf, branch, depth, index, root) -> bool

def is_valid_normalized_merkle_branch(leaf, branch, gindex, root) -> bool:
    depth = floorlog2(gindex)
    index = get_subtree_index(gindex)
    num_extra = len(branch) - depth
    for i in range(num_extra):
        if branch[i] != Bytes32():      # the extra nodes MUST be zero
            return False
    return is_valid_merkle_branch(leaf, branch[num_extra:], depth, index, root)
```

The normalized form is what the light client actually calls, and the `num_extra` zero check is a
validity condition rather than bookkeeping — a branch carrying non-zero padding must be rejected, not
trimmed. Plus `get_subtree_index(g) = g % 2**floorlog2(g)` and `floorlog2`.

**`hash_tree_root` for the containers the light client needs**, which is a short list:
`BeaconBlockHeader`, `SigningData`, `SyncCommittee`, `SyncAggregate`, `LightClientHeader`,
`LightClientUpdate`, `LightClientBootstrap`, `LightClientFinalityUpdate`,
`LightClientOptimisticUpdate`.

Deliberately **not** in scope: the whole `BeaconState`. The light client never merkleizes one — it
verifies branches *into* a state root it is given, with the generalized indices as constants
(`FINALIZED_ROOT_GINDEX` = 105, `NEXT_SYNC_COMMITTEE_GINDEX` = 55).

## The oracle, which is the part worth getting right first

`ethereum/consensus-spec-tests`, MIT, and **GitHub is already reachable from this container** — no
allowlist change needed. Checked today:

- The repo is **archived**, last release `v1.6.0-beta.0` (2025-09-24). A fixed target, which is what
  you want from vectors. The generators live in `ethereum/consensus-specs`, still active.
- Release tarballs are 211 MB / 468 MB / 679 MB and the git repo is 2.47 GB. **Do not clone or untar
  any of it** — the disk on this machine has been sitting at 94%.
- Individual cases fetch fine over `raw.githubusercontent.com`, and are small:

```
tests/mainnet/altair/ssz_static/LightClientUpdate/ssz_random/case_0/
    roots.yaml                75 bytes      root: '0x27d8…'
    serialized.ssz_snappy  25,374 bytes
    value.yaml             55,877 bytes
```

`ssz_static` at that path has 39 containers and every light-client one is present.

**One format trap, already checked.** The files are named `.ssz_snappy` and are *not* framed snappy —
no `sNaPpY` stream header. They are the **raw block format**: a varint uncompressed length then the
tag stream. `98 c6 01` = 25368, and a block decompressor written against that produced exactly 25368
bytes. Forty lines, and it belongs in the vendoring script rather than in the repo: decompress and
read `roots.yaml` once, commit compact JSON, exactly as `packages/bls/test/vendor` does. No YAML
reader and no snappy package in the tree, and the tests stay network-free.

Take `general/phase0/ssz_generic` as well as the light-client containers. The generic suite covers
uints, bitlists, bitvectors and nested containers, which is where merkleization goes wrong; the
light-client containers alone would not exercise the padding rules.

**Why this ordering matters rather than being tidiness.** An SSZ implementation checked only against
itself is worthless, and this package has been burnt twice by exactly that — a pairing that was
bilinear, non-degenerate, order-r and the *wrong pairing*, and a cofactor chain with both signs
dropped. Both times the fix was reading a reference rather than recalling one. Vendoring the vectors
first means the first line of merkleization is written against an oracle.

## Notes

`hash_tree_root(deserialize(bytes)) == root` tests deserialization and merkleization together
against values the Ethereum project generated. That is an independent implementation, not this one
agreeing with itself.


## Done, 2026-08-04

`packages/ssz`: `src/merkle.wac` (merkleization, branches), `src/container.wac` (schema-driven
`hash_tree_root`), `src/beacon.wac` (the nine light-client containers as descriptors). 15 tests.

| | |
| --- | --- |
| `ssz_generic`, schema-free types | 745 / 745 |
| `ssz_generic`, classic containers | 303 / 303 |
| `ssz_generic`, progressive lists | 0 / 100 — different scheme, not used by a light client |
| `ssz_static`, light-client containers | 45 / 45 |

**Three bugs the vectors caught**, all of the shape this issue predicted — wrong and self-consistent:

1. Backwards-offset detection compared against the previous field's *provisional end* rather than its
   start, refusing every well-formed container with two variable fields. `BitsStruct`'s offsets are 11
   then 12 against an end of 13.
2. The first-offset check was untested: my perturbations left an odd byte count for a `List[uint16]`,
   so they were refused by the element-size check instead. Parity-preserving offsets fixed the test.
3. Descriptor indices are hand-numbered, so both failure modes were planted to confirm coverage — a
   field swap (root changes, size does not) and a branch depth change (size changes, and the message
   names the container and the byte difference).

Left for later, in the package README rather than here: progressive lists, the serialization
direction, and vendoring the ~2,100 invalid cases now that there is a decoder to point them at.
