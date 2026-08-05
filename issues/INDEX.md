# Open issues

Newest first. See `README.md` for what belongs here and what does not, and `closed/` for the
record of what has been fixed and why.

| # | summary | kind | symptom |
|---|---|---|---|
| [0082](open/0082-five-tests-fail-rather-than-slow-down-when-the-machine-is-busy.md) | five tests fail, rather than slow down, when the machine is busy | bug | wrong answer |
| [0081](open/0081-a-consensus-accepted-by-the-probe-is-not-a-consensus-tor-would-trust.md) | a consensus ACCEPTED by the probe is not one tor would trust | missing feature | not implemented |
| [0076](open/0076-an-app-worker-runs-main-once-so-a-test-pays-a-fresh-one-per-case.md) | an app worker runs `main` once, so a test pays a fresh one per case | performance | not implemented |
| [0066](open/0066-the-light-client-is-minimal-config-only-and-has-never-seen-a-real-chain.md) | the light client is minimal-config only and has never seen a real chain | missing feature | not implemented |
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
