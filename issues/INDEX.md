# Open issues

Newest first. See `README.md` for what belongs here and what does not, and `closed/` for the
record of what has been fixed and why.

| # | summary | kind | symptom |
|---|---|---|---|
| [0025](open/0025-listen-takes-no-address-so-every-server-binds-every-interface.md) | `listen` takes no address, so every server binds every interface | missing feature | not implemented |
| [0017](open/0017-deno-task-app-orphans-the-application-when-the-launcher-is-killed.md) | `deno task app` orphans the application when the launcher is killed | bug | wrong answer |
| [0014](open/0014-platform-has-no-way-to-write-bytes-to-standard-error.md) | platform has no way to write bytes to standard error | missing feature | not implemented |
| [0011](open/0011-node-crypto-overloads-keep-failing-type-check-and-redden-the-shared-suite.md) | `node:crypto` overloads keep failing type-check and reddening the shared suite | task | wrong answer |
| [0009](open/0009-forty-two-exported-wac-functions-that-nothing-calls.md) | forty-two exported wac functions that nothing calls, across eight packages | bug | no error |
| [0007](open/0007-json-throughput-bench-half-migrated-to-the-canonical-struct.md) | json's throughput bench is half-migrated to the Canonical struct and cannot run | bug | wrong answer |
| [0005](open/0005-mutation-testing-found-54-untested-behaviours.md) | surviving mutants: behaviours nothing checks (crypto finished; tls at 75, five other packages unmeasured) | task | wrong answer |
| [0003](open/0003-wacc-parser-does-not-implement-generics.md) | wacc's parser does not implement generics, so `std` is outside its corpus | missing feature | not implemented |
| [0024](open/0024-mutation-selection-is-inert-for-subprocess-tests-and-the-fallback-runs-them-worst-first.md) | mutation test-selection is inert for subprocess tests, and the fallback runs them worst-first | performance | wrong answer |
| [0021](open/0021-a-spawned-worker-that-does-not-parse-kills-the-parent.md) | a spawned worker whose source does not parse kills the parent | bug | trap |

An empty list is the expected state most of the time — see `README.md`: something you
can fix in a package you are already working in should just be fixed, and a package's
own roadmap lives in its README. This tracker is for what crosses those lines.
