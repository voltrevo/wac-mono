# Vendored RLP fixtures

Ethereum's own `RLPTests`, committed rather than fetched — 11 KB between the two files, and
`harness/fixtures.ts` draws the line at roughly a hundred: below it the offline property is worth more
than the bytes. `packages/bls/test/vendor/README.md` states that property and it is the one to keep:
*the tests need no network and cannot silently start passing because a download failed.*

| file | cases | what |
| --- | --: | --- |
| `rlptest.json` | 28 | valid encodings, with the value each one carries |
| `invalidRLPTest.json` | 26 | byte strings a canonical decoder must refuse |

## Where they came from

    https://raw.githubusercontent.com/ethereum/tests/<commit>/RLPTests/rlptest.json
    https://raw.githubusercontent.com/ethereum/tests/<commit>/RLPTests/invalidRLPTest.json

- **repository:** `ethereum/tests` (MIT)
- **commit:** `7693364be004b4a00f0efd8c1cba77becf2f87e0` — the last commit to touch `RLPTests`, 2019-07-23.
  A commit rather than `develop`, because a branch moves and then "where this came from" is a guess.
- **sha256, as fetched:**
  - `rlptest.json` — `dd11055db749a21d8ee7aae7810ac30d19a89e2c6dadba9967f7bd567ad5fc00`
  - `invalidRLPTest.json` — `f90bf5745d21bfa7fbfeabaf5b6d1c66bae10051b1c0a054eecd424d488385d7`

Re-fetch with the two URLs above and check the hashes. They are recorded here rather than in a manifest
because these files are committed: git already fixes the content, and the hashes are for whoever wants to
confirm the bytes against upstream without a wider diff.

## What the corpus does not cover

**Trailing bytes.** Every one of the twenty-six invalid cases is malformed *inside* an item — a length
prefix with a leading zero, a declared length that overruns, a single byte spelled the long way. None of
them is a valid item followed by more bytes, so deleting `decode`'s trailing-bytes check leaves all
twenty-six passing. Measured, not assumed, and `test_trailing_bytes_are_refused` in
`../wac/rlp_test.wac` is the case set that closes it.

That is worth knowing before adding a rule and calling the corpus its proof: two of the three canonicity
rules are load-bearing against these fixtures (2 cases catch a leading zero, 6 catch a non-minimal long
form), and the third is not covered at all.
