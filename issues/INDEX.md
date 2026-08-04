# Open issues

Newest first. See `README.md` for what belongs here and what does not, and `closed/` for the
record of what has been fixed and why.

| # | summary | kind | symptom |
|---|---|---|---|
| [0062](open/0062-a-read-failure-has-no-fault-category-so-nine-programs-print-the-hosts-wording.md) | a read failure has no fault category, so nine programs print the host's wording | diagnostic | wrong answer |
| [0061](open/0061-sh-applets-return-all-their-output-at-once-so-a-large-stage-dies.md) | `sh`'s applets return all their output at once, so a large stage dies instead of streaming | bug | trap |
| [0036](open/0036-nothing-bounds-a-hung-test-and-four-helpers-wait-forever.md) | nothing bounds a hung test, and four readiness helpers are written to wait forever | bug | hang |
| [0035](open/0035-crypto-hot-paths-hold-state-in-gc-arrays-rather-than-locals.md) | crypto hot paths hold state in GC arrays rather than locals (measured: −64% on one function) | performance | wrong answer |
| [0034](open/0034-sha256s-one-shot-path-copies-the-whole-message-with-a-scalar-loop.md) | `sha256`'s one-shot path copies the whole message with a scalar loop | performance | wrong answer |
| [0033](open/0033-a-file-that-parses-but-is-not-a-worker-bundle-wedges-the-shell.md) | a file that parses but is not a worker bundle wedges the shell for ever | bug | trap |
| [0031](open/0031-a-mutation-sweep-starves-every-other-agent-on-this-machine.md) | a mutation sweep starves every other agent on this machine | performance | wrong answer |
| [0011](open/0011-node-crypto-overloads-keep-failing-type-check-and-redden-the-shared-suite.md) | `node:crypto` overloads keep failing type-check and reddening the shared suite | task | wrong answer |
| [0009](open/0009-forty-two-exported-wac-functions-that-nothing-calls.md) | forty-two exported wac functions that nothing calls, across eight packages | bug | no error |
| [0005](open/0005-mutation-testing-found-54-untested-behaviours.md) | surviving mutants: behaviours nothing checks (crypto finished; tls at 75, five other packages unmeasured) | task | wrong answer |
| [0003](open/0003-wacc-parser-does-not-implement-generics.md) | wacc's parser does not implement generics, so `std` is outside its corpus | missing feature | not implemented |
| [0024](open/0024-mutation-selection-is-inert-for-subprocess-tests-and-the-fallback-runs-them-worst-first.md) | mutation test-selection is inert for subprocess tests, and the fallback runs them worst-first | performance | wrong answer |
| [0028](open/0028-sh-decides-nothing-about-what-wacpath-programs-may-do.md) | `sh` passes `GRANT_NONE` to `$WACPATH` programs, which is a decision nobody has made | task | not implemented |

An empty list is the expected state most of the time — see `README.md`: something you
can fix in a package you are already working in should just be fixed, and a package's
own roadmap lives in its README. This tracker is for what crosses those lines.
