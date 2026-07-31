# JSONTestSuite corpus

Vendored, unmodified, from [nst/JSONTestSuite](https://github.com/nst/JSONTestSuite)
`test_parsing/`, fetched 2026-07-31. MIT licensed.

318 documents. The first two characters of each filename are the expectation:

| prefix | count | meaning |
|---|---:|---|
| `y_` | 95 | must be accepted |
| `n_` | 188 | must be rejected |
| `i_` | 35 | implementation-defined; either answer is conformant |

Vendored rather than fetched at test time so the suite runs offline and cannot
change underneath a passing build.
