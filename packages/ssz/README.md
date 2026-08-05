# ssz — Ethereum's SimpleSerialize, and the Merkle proofs built on it

**Everything an Altair light client needs is done and checked against Ethereum's vectors.** 2,233 of
them: 1,057 valid `ssz_generic`, 1,131 **invalid** `ssz_generic`, and all 45 `ssz_static`. Issues
**0063** and **0064** are both closed — `packages/lightclient` follows the chain on top of this.

| | state |
| --- | --- |
| `merkleize`, `mixInLength`, `zeroHash`, chunking | **done** |
| `hash_tree_root` of uints, booleans, bitvectors, bitlists, basic vectors and lists | **done** — 754 Ethereum `ssz_generic` cases |
| `isValidMerkleBranch`, `isValidNormalizedMerkleBranch` | **done** — 9 real Ethereum light-client proofs |
| `hash_tree_root` of containers, lists and vectors of composites | **done** — 303 Ethereum `containers` cases, schema-driven |
| refusing malformed input | **done** — all 1,131 Ethereum `ssz_generic` *invalid* cases |
| progressive lists | **out of scope** — a different merkleization scheme; 160 valid + 132 invalid cases |
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

- **754 of the 1,217 `ssz_generic` cases** produce Ethereum's root exactly. The other 403 are
  `containers`. Counts are asserted per type (48 uints, 2 boolean, 54 bitvector, 450 bitlist, 191
  basic_vector), so a name-matching regex that stops matching shows up as a gap and not as a pass.
- **The limit is load-bearing, checked by planting the fault.** Making `merkleize` pad to its input
  instead of the type's limit fails the fixtures *and* a separate property test. That is the mistake
  that produces a merkleizer which is right for every full-length value and wrong for every short one.
- **`zeroHash(d)` equals the zero subtree it stands in for**, at every depth up to 6, so the
  optimisation and the thing it replaces cannot drift.
- **Nine real light-client proofs verify** — the current sync committee, the next, and the finalized
  root, for altair, deneb and electra. The vectors give no state root, so they look unusable without a
  `BeaconState` descriptor; the way through is that all three proofs in a fork come from the *same*
  object, so three gindexes at three depths must fold to one root. That has no circularity in it: a
  wrong side-bit rule gives three different answers.
- **The generalized indices are fork-dependent, and the vectors show it.** Altair and Deneb put the
  sync committees at 54/55 and the finalized root at 105; **Electra moved them to 86/87 and 169**, a
  level deeper. That is the concrete reason `is_valid_normalized_merkle_branch` exists: the same
  logical proof is 5 nodes under one fork and 6 under another, so a shallower proof appears in the
  deeper layout with leading nodes that **must be zero**. `src/beacon.wac` declares the Altair depths,
  which is right for the fork it names — a client extended past Deneb has to make them fork-dependent,
  and `test/proof_wac.test.ts` is where that will fail first.
- **Branch verification is also tested against a tree built with the *host's* SHA-256**, via Web Crypto —
  not against this package's merkleizer. Building the tree with wac and then checking it with wac
  would be a symmetric oracle: both halves wrong together would still agree. Every leaf position is
  verified, and a wrong index, a flipped byte and a short branch are each refused.
- **The normalized branch's surplus nodes must be zero.** A zero-padded branch is accepted, a branch
  with non-zero surplus is refused rather than trimmed. That is a validity condition — accepting it
  would let a prover hang an unrelated subtree below the field being proved.
- **303 of the 463 `containers` cases** produce Ethereum's root, driven by descriptors transcribed from
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

## Where the vectors come from

**Not from git.** `test/fixtures.json` is a manifest — a pinned upstream commit SHA and the SHA-256 of
each derived set — and `harness/fixtures.ts` produces the data into `.cache/fixtures` on a cold cache,
verifying it against that hash. `tools/vendor.py` is the generator. See `harness/fixtures.ts` for the
reasoning; the short version is that the sets worth having next (about 2,100 invalid cases, other
forks, other configs) are far larger than the 1.7 MB that used to sit in the repo.

| set | cases | what |
| --- | --- | --- |
| `light_client_proofs` | 9 | 3 Merkle proofs into one `BeaconState`, for altair, deneb and electra |
| `light_client_sync_altair_minimal` | 4 | sync-protocol cases: a bootstrap and a sequence of steps with per-step store assertions |
| `ssz_static_altair_mainnet` | 45 | the nine containers an Altair light client touches, `mainnet` config |
| `ssz_generic_valid` | 1,217 | `uints`, `boolean`, `bitlist`, `bitvector`, `basic_vector`, `containers` |

The property vendoring bought is kept: **a fixture that cannot be produced is an error, never a
skip.** A suite that quietly drops its oracle when the network is unavailable reports a better number
for checking less. And the committed hash makes it *stronger* than vendoring — nothing previously
checked that the committed JSON still matched upstream, so a case mis-decompressed at vendoring time
would have been baked in for ever.

Cold-cache cost: one 211 MB release-tarball download for `ssz_generic_valid`, once per machine.

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

**Nothing is dropped any more.** The old 8 KB cap existed only because the output went into git; the
cache has no such constraint, so all 1,217 valid cases are used — including the 1.76 MB
`ComplexTestStruct` that is the only real exercise of long-list merkleization. `SIZE_CAP` survives as
a knob in `tools/vendor.py`, set high.

**Invalid cases are not vendored yet.** `ssz_generic` ships about 2,100 of them, and they are the more
valuable half — a decoder that accepts a malformed offset is the bug that matters. They carry no
expected root, only the requirement that decoding fails, so they need the decoder to exist first to be
worth anything. Next after the encoder round-trips.

## The sync-protocol vectors are vendored ahead of the client

`light_client_sync_altair_minimal` holds the oracle for wac-mono **0064**, committed before the client
exists because vendoring it was the hard half. The steps come from a restricted YAML with no parser
available here, so `tools/vendor.py` grew one — and a hand-written parser that silently drops a step
leaves a client passing a shorter test than it believes. Every `- ` step and every `key:` was
cross-checked against the raw YAML: 10/10, 3/3, 5/5 and 1/1 steps, 96/96, 28/28, 50/50 and 10/10 keys.

Two things that came free, each an independent check on layouts asserted elsewhere:

- the bootstrap is **exactly 1,856 bytes**, which is minimal-config `112 + (32×48 + 48) + 5×32`. The
  same container is 24,896 under mainnet, so this confirms both the snappy decode and that these
  really are minimal-config objects.
- an update is **exactly 2,268 bytes**, `112 + 1584 + 160 + 112 + 192 + 100 + 8`.

**These are `minimal` config and that is not cosmetic.** `SYNC_COMMITTEE_SIZE` is 32 rather than 512,
so `src/beacon.wac`'s mainnet table cannot drive them; a client checked against these needs a second
descriptor table. The three `*_store_with_legacy_data` cases are excluded — they exercise
`upgrade_store` across forks and need capella-and-later descriptors, which is a fork-support question
rather than a sync-protocol one.

## What is left

- **Progressive lists** (`ProgressiveList`, `ProgressiveBitList`) — a different merkleization scheme,
  100 vendored cases, and not used by a light client. The only reason to do them is completeness.
- **Serialization** — this package computes roots from bytes and never produces bytes. A light client
  only needs the reading direction, but a signer or a gossip publisher would need the other.
*(Invalid-case vectors were the third item here. They are done — see below.)*

## The invalid vectors found three real bugs

`test/invalid_wac.test.ts` runs Ethereum's 1,131 malformed `ssz_generic` encodings and requires every
one to be **refused**. Unlike every other suite here it compares against no expected value, because an
invalid case ships `serialized.ssz_snappy` with no `meta.yaml` — there is no correct root. It can
therefore only be wrong about whether a refusal happened.

That is worth more than it sounds. A malformed object that merkleizes anyway yields a root, and a root
is what consensus *is*; two clients disagreeing about whether an encoding is legal disagree about a
`hash_tree_root`. Three things were wrong, and all three produce a *different root* rather than merely
an accepted byte string — so each was a way for this package to fork the chain:

- **`boolean` was not a type.** It was `uint8`, so `0x02` was a perfectly good boolean. SSZ merkleizes
  a boolean into a chunk padded with 31 zero bytes, so `0x02` and `0x01` have different roots — two
  encodings of "true" that do not agree. 84 cases. Fixed by `KIND_BOOLEAN`.
- **A `Bitvector[N]`'s bits above N were not required to be zero.** `Bitvector[1]` holding `0x03` is
  the same *length* as one holding `0x01`, so the length check accepted it. 30 cases.
- **`Vector[T, 0]` and `Bitvector[0]` were accepted.** Neither is a type — the spec requires N > 0.
  8 cases.

The remaining 1,009 were already refused, which is the part the hand-built perturbations had been
standing in for.

A case whose name this file cannot parse is a **failure, not a skip**. The type has to be recovered
from the directory name (`vec_uint16_5_nil`, `bitlist_2_but_3`, `ComplexTestStruct_offset_zeroed`), and
a parser that quietly dropped what it did not understand would report a smaller, cleaner, meaningless
number.

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

`ssz_static` is fetched case by case — 90 raw files, **no GitHub API calls**. The API is 60 requests
an hour unauthenticated, and listing directories exhausted it after a few cold rebuilds, failing with
a 403 that looks nothing like a rate limit. Pinning a commit is what makes listing unnecessary: at a
fixed SHA the tree cannot change, so the case names are enumerated in the generator. `ssz_generic`
comes from the release tarball — one request instead of thousands. **Do not clone the repo**: it is 2.47 GB, and this machine's disk has been sitting near
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
