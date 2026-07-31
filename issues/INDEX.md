# Open issues

Newest first. See `README.md` for what belongs here and what does not, and `closed/` for the
record of what has been fixed and why.

| # | summary | kind | symptom |
|---|---|---|---|
| [0004](open/0004-hashbytes-belongs-in-std-not-in-bytes.md) | FNV-1a is written twice: `hashBytes` in `bytes` duplicates `hashString` in `std` | bug | wrong answer |
| [0003](open/0003-wacc-parser-does-not-implement-generics.md) | wacc's parser does not implement generics, so `std` is outside its corpus | missing feature | not implemented |
| [0002](open/0002-coverage-and-mutate-only-see-gzip.md) | `coverage` and `mutate` only see gzip, but report as if repo-wide | bug | wrong answer |
| [0001](open/0001-the-compiler-is-an-unpinned-dependency.md) | the compiler is an unpinned dependency, and a stale one blames the wrong package | bug | compile error |

An empty list is the expected state most of the time — see `README.md`: something you
can fix in a package you are already working in should just be fixed, and a package's
own roadmap lives in its README. This tracker is for what crosses those lines.
