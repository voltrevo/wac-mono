# Open issues

Newest first. See `README.md` for what belongs here and what does not, and `closed/` for the
record of what has been fixed and why.

| # | summary | kind | symptom |
|---|---|---|---|
| [0095](open/0095-sha256-is-13x-off-openssl-and-most-of-it-is-not-shape.md) | `sha256` is 13x off OpenSSL, and most of that is not a shape problem | performance | not implemented |
| [0094](open/0094-nothing-has-ever-run-wasm-opt-over-what-we-ship.md) | nothing has ever run `wasm-opt` over what we ship, and it halves the module | performance | not implemented |
| [0093](open/0093-eight-private-slices-that-disagree-about-a-bad-range.md) | eight private `slice`s, and they disagree about a bad range | bug | wrong answer |
| [0092](open/0092-the-capability-layer-should-be-its-own-repo.md) | the capability layer should be its own repo (`wac-platform`) — blocked on a directory provider in the compiler | missing feature | not implemented |
| [0091](open/0091-relayd-may-hold-more-outstanding-calls-than-the-platform-ring-has-slots.md) | `relayd` may hold more outstanding calls than the platform ring has slots | bug | hangs |
| [0088](open/0088-zstd-is-whole-buffer-in-both-directions.md) | zstd is whole-buffer in both directions, and gzip is not | missing feature | not implemented |
| [0087](open/0087-wacland-under-wasmtime-a-second-host-with-no-javascript.md) | the native runtime: a second host, with no JavaScript and no WASI in it | missing feature | not implemented |
| [0076](open/0076-an-app-worker-runs-main-once-so-a-test-pays-a-fresh-one-per-case.md) | an app worker runs `main` once, so a test pays a fresh one per case | performance | not implemented |
| [0066](open/0066-the-light-client-is-minimal-config-only-and-has-never-seen-a-real-chain.md) | the light client is minimal-config only and has never seen a real chain | missing feature | not implemented |
| [0009](open/0009-forty-two-exported-wac-functions-that-nothing-calls.md) | forty-two exported wac functions that nothing calls, across eight packages | bug | no error |
| [0005](open/0005-mutation-testing-found-54-untested-behaviours.md) | surviving mutants: behaviours nothing checks (crypto finished; tls at 75, five other packages unmeasured) | task | wrong answer |

An empty list is the expected state most of the time — see `README.md`: something you
can fix in a package you are already working in should just be fixed, and a package's
own roadmap lives in its README. This tracker is for what crosses those lines.
