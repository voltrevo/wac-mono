# Vendored test vectors

Committed rather than fetched, so the tests need no network and cannot silently start passing
because a download failed.

## `hash_to_G2.json`

The CFRG hash-to-curve draft's own vectors for `BLS12381G2_XMD:SHA-256_SSWU_RO_`, from
`cfrg/draft-irtf-cfrg-hash-to-curve`, `poc/vectors/`.

**These are worth more than a final answer.** Each vector carries the intermediate values —
`u` from `hash_to_field`, then `Q0` and `Q1` from `map_to_curve` before the cofactor is cleared,
then `P`. So a wrong isogeny constant fails at `Q0` and a wrong cofactor clearing fails only at
`P`, which is the difference between a located bug and a wrong point.

Note the DST is the draft's own test string, not Ethereum's. `hash_to_G2` therefore takes the DST
as a parameter, is checked here against the draft's, and is used with Ethereum's by `verify`.

## `eth_*.json`

`ethereum/bls12-381-tests` v0.1.2, from its release tarball, **CC0 1.0** — one file per test
group, each a map from the fixture's own name to its case, so a failure names the file the
Ethereum project chose for it.

These are the consensus-critical cases and most of them are refusals. The names are the
documentation: `deserialization_fails_infinity_with_false_b_flag`,
`deserialization_fails_too_few_bytes`, `verify_infinity_pubkey_and_infinity_signature`. That last
one is the sort of thing no amount of arithmetic testing reaches.

`sign` and `aggregate` are deliberately not vendored: this package verifies and does not sign, so
those fixtures would be a claim it cannot make.

## Refreshing

    curl -sSL -o t.tar.gz https://github.com/ethereum/bls12-381-tests/releases/download/v0.1.2/bls_tests_json.tar.gz

then re-run the small script recorded in this package's commit for the flattening. Pin the tag:
an unpinned refresh that quietly gains cases is a suite whose meaning changed without a diff.
