# Open issues

Newest first. See `README.md` for what belongs here and what does not, and `closed/` for the
record of what has been fixed and why.

| # | summary | kind | symptom |
|---|---|---|---|
| [0092](open/0092-the-capability-layer-should-be-its-own-repo.md) | the capability layer should be its own repo (`wac-platform`) — blocked on a directory provider in the compiler | missing feature | not implemented |
| [0091](open/0091-relayd-may-hold-more-outstanding-calls-than-the-platform-ring-has-slots.md) | `relayd` may hold more outstanding calls than the platform ring has slots | bug | hangs |
| [0090](open/0090-a-line-the-tests-demonstrably-execute-is-reported-not-covered.md) | a line the tests demonstrably execute is reported "not covered" | bug | wrong answer |
| [0088](open/0088-zstd-is-whole-buffer-in-both-directions.md) | zstd is whole-buffer in both directions, and gzip is not | missing feature | not implemented |
| [0087](open/0087-wacland-under-wasmtime-a-second-host-with-no-javascript.md) | the native runtime: a second host, with no JavaScript and no WASI in it | missing feature | not implemented |
| [0086](open/0086-merkle-patricia-proofs-so-a-contract-read-is-verified.md) | Merkle-Patricia proofs, so reading a contract does not mean trusting the answer | missing feature | not implemented |
| [0085](open/0085-abi-encoding-and-decoding.md) | ABI encoding and decoding, so a contract call can be made and its answer read | missing feature | not implemented |
| [0084](open/0084-rlp-encoding-and-decoding.md) | RLP, the encoding everything below the consensus layer uses | missing feature | not implemented |
| [0083](open/0083-keccak256-for-ethereum-not-just-sha3.md) | keccak256, which is not SHA3-256 | missing feature | not implemented |
| [0076](open/0076-an-app-worker-runs-main-once-so-a-test-pays-a-fresh-one-per-case.md) | an app worker runs `main` once, so a test pays a fresh one per case | performance | not implemented |
| [0066](open/0066-the-light-client-is-minimal-config-only-and-has-never-seen-a-real-chain.md) | the light client is minimal-config only and has never seen a real chain | missing feature | not implemented |
| [0035](open/0035-crypto-hot-paths-hold-state-in-gc-arrays-rather-than-locals.md) | crypto hot paths hold state in GC arrays rather than locals (measured: −64% on one function) | performance | wrong answer |
| [0034](open/0034-sha256s-one-shot-path-copies-the-whole-message-with-a-scalar-loop.md) | `sha256`'s one-shot path copies the whole message with a scalar loop | performance | wrong answer |
| [0009](open/0009-forty-two-exported-wac-functions-that-nothing-calls.md) | forty-two exported wac functions that nothing calls, across eight packages | bug | no error |
| [0005](open/0005-mutation-testing-found-54-untested-behaviours.md) | surviving mutants: behaviours nothing checks (crypto finished; tls at 75, five other packages unmeasured) | task | wrong answer |

An empty list is the expected state most of the time — see `README.md`: something you
can fix in a package you are already working in should just be fixed, and a package's
own roadmap lives in its README. This tracker is for what crosses those lines.
