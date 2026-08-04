# ssz — Ethereum's SimpleSerialize, and the Merkle proofs built on it

**Nothing is implemented yet.** This directory currently holds the *oracle*: Ethereum's own test
vectors, reshaped so the tests need no network. That ordering is deliberate — see below.

Tracked as wac-mono issue **0063**, and its consumer is **0064**, an Altair light client.

## Why the vectors came first

Everything a beacon chain signs is an SSZ `hash_tree_root`, so `packages/bls` can verify Ethereum
signatures today but cannot verify what they are *about*. SSZ is the missing piece.

It is also a format that is easy to implement plausibly and wrongly. This package has been bitten
twice by exactly that: a pairing that was bilinear, non-degenerate, order-r and *a different
pairing*, and a cofactor-clearing chain with both of its sign flips dropped. Both were written from
recollection and both passed every self-consistency check available. So the first commit here is the
thing that makes a wrong implementation fail: 1,193 cases the Ethereum project generated.

## What is vendored

`test/vendor/`, 1.7 MB, produced by `tools/vendor.py` from `ethereum/consensus-spec-tests`
v1.6.0-beta.0 (MIT). Committed rather than fetched, so a failed download cannot make the tests pass.

| file | cases | what |
| --- | --- | --- |
| `ssz_static_altair_mainnet.json` | 45 | the nine containers an Altair light client touches, `mainnet` config |
| `ssz_generic_valid.json` | 1,148 | `uints`, `boolean`, `bitlist`, `bitvector`, `basic_vector`, `containers` |

Each case is `{ssz, root}` in hex. The assertion they support is

```
hash_tree_root(deserialize(ssz)) == root
```

which tests deserialization and merkleization together against a value this repo had no hand in
producing.

`mainnet` and not `minimal`: `SYNC_COMMITTEE_SIZE` is 512 against 32, so a `SyncCommittee` root from
the minimal config is a root for a different type.

### What the fixtures were checked to mean

A fixture file is only an oracle if you know what its numbers are. Both halves of the convention were
reproduced independently, in fifteen lines of Python, before any of this was committed:

- **basic types** — 50 of 50 `uints` and `boolean` roots equal the serialization right-padded to one
  32-byte chunk;
- **merkleization** — 191 of 191 `basic_vector` roots are reproduced by pack → chunk into 32 bytes →
  pad the chunk count to a power of two → hash pairwise with SHA-256.

So `root` is the `hash_tree_root` of the value `ssz` encodes, under the conventions above, and not
something else that happens to be 32 bytes.

### What was left out, and why

**69 of the 1,217 valid `ssz_generic` cases are dropped**, every one of them over 8 KB serialized.
The full set is 47 MB of JSON, almost all of it `containers` — 463 cases totalling 24 MB, the largest
a single 1.76 MB `ComplexTestStruct`. Those cases repeat structure the small ones already cover
(offsets, nesting, variable-size members), so the cap costs coverage of *length* rather than of shape.
`SIZE_CAP` in `tools/vendor.py` is the knob, and the fixture records `dropped` and
`droppedLargestBytes` so the omission is visible in the data rather than only in this paragraph.

**Invalid cases are not vendored yet.** `ssz_generic` ships about 2,100 of them, and they are the more
valuable half — a decoder that accepts a malformed offset is the bug that matters. They carry no
expected root, only the requirement that decoding fails, so they need the decoder to exist first to be
worth anything. Next after the encoder round-trips.

## Scope, when it is written

Read off `consensus-specs/specs/altair/light-client/sync-protocol.md`:

- merkleization — chunking, `mix_in_length`, bitlist and bitvector packing
- `is_valid_merkle_branch(leaf, branch, depth, index, root)`
- `is_valid_normalized_merkle_branch(leaf, branch, gindex, root)`, whose `num_extra` leading branch
  nodes **must be zero** — a validity condition, not padding to trim
- `get_subtree_index(g) = g % 2**floorlog2(g)`, and `floorlog2`
- `hash_tree_root` for the nine light-client containers

Not in scope: merkleizing a whole `BeaconState`. A light client never does — it verifies branches
*into* a state root it is handed, with the generalized indices as constants (`FINALIZED_ROOT_GINDEX`
= 105, `NEXT_SYNC_COMMITTEE_GINDEX` = 55).

## Re-running the vendoring

```
python3 packages/ssz/tools/vendor.py static                      # ~135 requests, small files
python3 packages/ssz/tools/vendor.py generic <general.tar.gz>     # one 211 MB download
```

`ssz_static` is fetched case by case because the light-client containers are only about forty cases.
`ssz_generic` has over a thousand, so it comes from the release tarball — one request instead of
thousands. **Do not clone the repo**: it is 2.47 GB, and this machine's disk has been sitting near
90%. The tarball is transient and belongs in a scratch directory.

The upstream repo is **archived** as of 2025-10-21, so `v1.6.0-beta.0` is the last release and this is
a fixed target. The generators live on in `ethereum/consensus-specs`.

### One trap worth knowing before you touch the format

The files are named `.ssz_snappy` and are **not** framed snappy — there is no `sNaPpY` stream header.
They are the raw block format: a varint uncompressed length, then the tag stream. The first case
inspected began `98 c6 01`, which is 25368, and a block decoder produced exactly 25368 bytes. A
framed decoder rejects the first byte. `ssz_static` also names its root file `roots.yaml` while
`ssz_generic` names it `meta.yaml`; both hold one `root: '0x…'` line, which is why there is no YAML
reader here.
