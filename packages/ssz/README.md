# ssz — Ethereum's SimpleSerialize, and the Merkle proofs built on it

**Everything an Altair light client needs is done and checked against Ethereum's vectors.** 1,093 of
them: 1,048 `ssz_generic` and all 45 `ssz_static`. Issue **0063** is closed; **0064**, the light client
itself, is unblocked.

| | state |
| --- | --- |
| `merkleize`, `mixInLength`, `zeroHash`, chunking | **done** |
| `hash_tree_root` of uints, booleans, bitvectors, bitlists, basic vectors and lists | **done** — 745 Ethereum `ssz_generic` cases |
| `isValidMerkleBranch`, `isValidNormalizedMerkleBranch` | **done** |
| `hash_tree_root` of containers, lists and vectors of composites | **done** — 303 Ethereum `containers` cases, schema-driven |
| progressive lists | **out of scope** — a different merkleization scheme; 100 cases |
| the nine light-client containers | **done** — all 45 Ethereum `ssz_static` cases |

`src/merkle.wac` is merkleization; `src/container.wac` is a **schema-driven** `hash_tree_root` — a type
is four `i32`s in a flat table (`kind, param, child, count`), so a container is described rather than
hand-written and the whole descriptor crosses the JS boundary as an `i32[]`. The nine light-client
containers are now nine descriptors, not nine functions.

Four things this says loudest, because they are where implementations go wrong:

- **the pad target is the type's limit, not the data's length**
- **a bitlist's trailing delimiter bit is measured, not merkleized**
- **a variable field's extent comes from the *next* offset**, and the last runs to the container's end
- **the first offset must equal the fixed part's size** — a serialization saying otherwise is
  malformed, not unusual

## What the tests establish

`deno test -A packages/ssz/` — 9 tests, and the numbers rather than the names:

- **745 of the 1,148 `ssz_generic` cases** produce Ethereum's root exactly. The other 403 are
  `containers`. Counts are asserted per type (48 uints, 2 boolean, 54 bitvector, 450 bitlist, 191
  basic_vector), so a name-matching regex that stops matching shows up as a gap and not as a pass.
- **The limit is load-bearing, checked by planting the fault.** Making `merkleize` pad to its input
  instead of the type's limit fails the fixtures *and* a separate property test. That is the mistake
  that produces a merkleizer which is right for every full-length value and wrong for every short one.
- **`zeroHash(d)` equals the zero subtree it stands in for**, at every depth up to 6, so the
  optimisation and the thing it replaces cannot drift.
- **Branch verification is tested against a tree built with the *host's* SHA-256**, via Web Crypto —
  not against this package's merkleizer. Building the tree with wac and then checking it with wac
  would be a symmetric oracle: both halves wrong together would still agree. Every leaf position is
  verified, and a wrong index, a flipped byte and a short branch are each refused.
- **The normalized branch's surplus nodes must be zero.** A zero-padded branch is accepted, a branch
  with non-zero surplus is refused rather than trimmed. That is a validity condition — accepting it
  would let a prover hang an unrelated subtree below the field being proved.
- **303 of the 403 `containers` cases** produce Ethereum's root, driven by descriptors transcribed from
  the generator's own definitions in `consensus-specs/tests/formats/ssz_generic/README.md`.
  `ComplexTestStruct` is the one that earns its keep: seven fields, four variable, a nested container,
  a vector of fixed containers and a vector of *variable* ones.
- **All 45 light-client `ssz_static` cases** produce Ethereum's root, from the descriptors in
  `src/beacon.wac`. Their serialized sizes are asserted separately, because the two failures localise
  differently: a wrong size means a wrong field list and is computable from the descriptor alone, while
  a wrong root at the right size means wrong nesting or a wrong limit. Both were confirmed by planting
  faults — swapping `SyncCommittee`'s two fields changes the root and not the size, and shortening the
  finality branch from 6 to 5 changes the size and says which container by how many bytes.
- **Both offset checks were confirmed load-bearing by removing them**, and one of those attempts found
  a vacuous test. Details below, because the second is the more useful finding.

### Two bugs the vectors caught, and one the tests nearly missed

**Offsets going backwards were compared against the wrong field.** The check read
`abs < finish[prevVar]`, and `finish[prevVar]` is still the *provisional* container end — the very
value the new offset is about to narrow. So every well-formed container with two variable fields was
refused. `BitsStruct` has offsets 11 then 12 against an end of 13, and 12 < 13 looked backwards. The
comment above the line said "must not go backwards" and was right; the line was wrong.

**Removing the first-offset check broke nothing**, which meant that test was vacuous. `VarTestStruct`'s
variable field is a `List[uint16, 1024]`, so the offsets I had picked (6 and 8) left an *odd* number of
bytes and were refused by the element-size check rather than the offset check. Parity-preserving
offsets (5, 9, 11 — matching the 7-byte fixed part) close that escape, and with them removing the
check fails as it should. Worth writing down because the test looked exactly like a test that worked.

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

## What is left

- **Progressive lists** (`ProgressiveList`, `ProgressiveBitList`) — a different merkleization scheme,
  100 vendored cases, and not used by a light client. The only reason to do them is completeness.
- **Serialization** — this package computes roots from bytes and never produces bytes. A light client
  only needs the reading direction, but a signer or a gossip publisher would need the other.
- **Invalid-case vectors** — about 2,100 of them upstream, and the more valuable half, since a decoder
  that accepts a malformed offset is the bug that matters. They need this decoder to exist, which it
  now does, so vendoring them is the obvious next hardening step. The refusals are currently tested by
  hand-built perturbations rather than by Ethereum's own malformed cases.

## What it implements, from the spec

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
