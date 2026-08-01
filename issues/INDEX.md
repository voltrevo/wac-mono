# Open issues

Newest first. See `README.md` for what belongs here and what does not, and `closed/` for the
record of what has been fixed and why.

| # | summary | kind | symptom |
|---|---|---|---|
| [0007](open/0007-json-throughput-bench-half-migrated-to-the-canonical-struct.md) | json's throughput bench is half-migrated to the Canonical struct and cannot run | bug | wrong answer |
| [0006](open/0006-streaming-gzip-is-now-representable.md) | streaming gzip is now representable, and was not before | missing feature | not implemented |
| [0005](open/0005-mutation-testing-found-54-untested-behaviours.md) | surviving mutants: behaviours nothing checks (31 open) | task | wrong answer |
| [0003](open/0003-wacc-parser-does-not-implement-generics.md) | wacc's parser does not implement generics, so `std` is outside its corpus | missing feature | not implemented |
| [0001](open/0001-the-compiler-is-an-unpinned-dependency.md) | the compiler is an unpinned dependency, and a stale one blames the wrong package | bug | compile error |

An empty list is the expected state most of the time — see `README.md`: something you
can fix in a package you are already working in should just be fixed, and a package's
own roadmap lives in its README. This tracker is for what crosses those lines.
