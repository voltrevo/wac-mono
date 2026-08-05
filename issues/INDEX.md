# Open issues

Newest first. See `README.md` for what belongs here and what does not, and `closed/` for the
record of what has been fixed and why.

| # | summary | kind | symptom |
|---|---|---|---|
| [0072](open/0072-wcs-counts-are-i32-so-above-2-gb-they-go-negative.md) | `wc`'s counts are i32, so above 2 GB they go negative | bug | wrong answer |
| [0071](open/0071-nine-of-shs-programs-read-all-of-their-input-before-answering.md) | nine of `sh`'s programs read all of their input before answering | bug | trap |
| [0070](open/0070-a-redirection-collects-a-childs-whole-output-before-writing-the-file.md) | a redirection collects a child's whole output before writing the file | bug | trap |
| [0068](open/0068-the-deno-transpile-cache-grows-without-bound-and-filled-the-shared-disk.md) | the Deno transpile cache grows without bound, and filled the shared disk | bug | disk full |
| [0067](open/0067-no-filesystem-of-our-own-so-a-session-cannot-be-sealed-off-from-the-host.md) | no filesystem of our own, so a session cannot be sealed off from the host — [design/0001](../design/0001-a-self-contained-system.md) step 1 | missing feature | not implemented |
| [0065](open/0065-a-spawned-programs-arguments-are-not-byte-exact.md) | a spawned program's arguments are not byte-exact | bug | wrong answer |
| [0066](open/0066-the-light-client-is-minimal-config-only-and-has-never-seen-a-real-chain.md) | the light client is minimal-config only and has never seen a real chain | missing feature | not implemented |
| [0069](open/0069-tests-hand-out-ports-by-binding-and-releasing-them.md) | tests hand out ports by binding one and releasing it, which is a race | bug | flake |
| [0035](open/0035-crypto-hot-paths-hold-state-in-gc-arrays-rather-than-locals.md) | crypto hot paths hold state in GC arrays rather than locals (measured: −64% on one function) | performance | wrong answer |
| [0034](open/0034-sha256s-one-shot-path-copies-the-whole-message-with-a-scalar-loop.md) | `sha256`'s one-shot path copies the whole message with a scalar loop | performance | wrong answer |
| [0031](open/0031-a-mutation-sweep-starves-every-other-agent-on-this-machine.md) | a mutation sweep starves every other agent on this machine | performance | wrong answer |
| [0011](open/0011-node-crypto-overloads-keep-failing-type-check-and-redden-the-shared-suite.md) | `node:crypto` overloads keep failing type-check and reddening the shared suite | task | wrong answer |
| [0009](open/0009-forty-two-exported-wac-functions-that-nothing-calls.md) | forty-two exported wac functions that nothing calls, across eight packages | bug | no error |
| [0005](open/0005-mutation-testing-found-54-untested-behaviours.md) | surviving mutants: behaviours nothing checks (crypto finished; tls at 75, five other packages unmeasured) | task | wrong answer |
| [0024](open/0024-mutation-selection-is-inert-for-subprocess-tests-and-the-fallback-runs-them-worst-first.md) | mutation test-selection is inert for subprocess tests, and the fallback runs them worst-first | performance | wrong answer |

An empty list is the expected state most of the time — see `README.md`: something you
can fix in a package you are already working in should just be fixed, and a package's
own roadmap lives in its README. This tracker is for what crosses those lines.
