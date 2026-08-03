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
| [0005](open/0005-mutation-testing-found-54-untested-behaviours.md) | surviving mutants: behaviours nothing checks (crypto finished; tls at 75, five other packages unmeasured) | task | wrong answer |
| [0003](open/0003-wacc-parser-does-not-implement-generics.md) | wacc's parser does not implement generics, so `std` is outside its corpus | missing feature | not implemented |
| [0024](open/0024-mutation-selection-is-inert-for-subprocess-tests-and-the-fallback-runs-them-worst-first.md) | mutation test-selection is inert for subprocess tests, and the fallback runs them worst-first | performance | wrong answer |
| [0021](open/0021-a-spawned-worker-that-does-not-parse-kills-the-parent.md) | a spawned worker whose source does not parse kills the parent | bug | trap |
| [0026](open/0026-sshds-port-announcement-test-is-racy-and-reddens-the-shared-suite.md) | sshd's port-announcement test is racy, and makes the shared suite red at random | bug | wrong answer |
| [0027](open/0027-writefile-cannot-say-why-it-failed.md) | `writeFile` and friends answer `bool`, so a failure cannot say why | missing feature | wrong answer |
| [0028](open/0028-sh-decides-nothing-about-what-wacpath-programs-may-do.md) | `sh` passes `GRANT_NONE` to `$WACPATH` programs, which is a decision nobody has made | task | not implemented |
| [0029](open/0029-gets-hand-rolls-tls-record-framing-that-now-lives-in-the-package.md) | `box gets` hand-rolls TLS record framing that now lives in the package | bug | no error |
| [0030](open/0030-a-page-cannot-spawn-so-the-browser-shell-runs-applets-in-process.md) | a page cannot `spawn`, so the browser shell runs applets in-process instead | missing feature | not implemented |
| [0043](open/0043-box-find-and-du-silently-truncate-valid-directory-trees-deeper-than-32.md) | box find and du silently truncate valid directory trees deeper than 32 levels | bug | wrong answer |
| [0044](open/0044-box-split-switches-from-alphabetic-suffixes-to-decimal-names-after-zz.md) | box split switches from alphabetic suffixes to decimal names after zz | bug | wrong answer |
| [0045](open/0045-rfc3339-parser-loses-the-distinct-0000-unknownoffset-value.md) | RFC3339 parser loses the distinct '-00:00' unknown-offset value | bug | wrong answer |
| [0047](open/0047-box-rm-f-suppresses-every-removal-failure-not-only-missing-files.md) | box rm -f suppresses every removal failure, not only missing files | bug | wrong answer |
| [0048](open/0048-readchunk-converts-input-errors-into-eof-so-streaming-programs-can-sil.md) | readChunk converts input errors into EOF, so streaming programs can silently succeed with truncated data | bug | wrong answer |
| [0049](open/0049-box-cat-ignores-a-closed-output-and-can-run-forever-after-its-downstre.md) | box cat ignores a closed output and can run forever after its downstream consumer exits | bug | trap |
| [0050](open/0050-box-find-and-du-treat-readdir-failures-as-empty-directories-and-exit-s.md) | box find and du treat readDir failures as empty directories and exit successfully | bug | wrong answer |
| [0053](open/0053-box-tar-silently-truncates-path-names-longer-than-100-bytes-despite-pr.md) | box tar silently truncates path names longer than 100 bytes despite promising to refuse them | bug | wrong answer |
| [0055](open/0055-box-tar-follows-symboliclink-directories-and-can-recurse-until-failure.md) | box tar follows symbolic-link directories and can recurse until failure on a cycle | bug | trap |
| [0056](open/0056-box-grep-reports-regex-budget-exhaustion-as-a-successful-match.md) | box grep reports regex budget exhaustion as a successful match | bug | wrong answer |
| [0057](open/0057-regex-opclear-can-write-past-its-undo-log-for-quantified-groups-with-m.md) | regex OP_CLEAR can write past its undo log for quantified groups with many captures | bug | trap |
| [0059](open/0059-json-stringify-emits-invalid-tokens-for-nan-and-infinities-in-handbuil.md) | JSON stringify emits invalid tokens for NaN and infinities in hand-built trees | bug | wrong answer |
| [0060](open/0060-json-stringify-can-emit-malformed-utf8-from-a-handbuilt-str-value.md) | JSON stringify can emit malformed UTF-8 from a hand-built Str value | bug | wrong answer |

An empty list is the expected state most of the time — see `README.md`: something you
can fix in a package you are already working in should just be fixed, and a package's
own roadmap lives in its README. This tracker is for what crosses those lines.
