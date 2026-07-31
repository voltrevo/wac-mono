# 0001 — the compiler is an unpinned dependency, and a stale one blames the wrong package

- **Status:** open
- **Reported by:** agent-b
- **Date:** 2026-07-31
- **Kind:** bug
- **Symptom:** compile error, attributed to the wrong place

`deno.json` maps `wac/` to `../wac/atoms/wac/` — whatever happens to be in the sibling
checkout. Nothing records which compiler this repo expects, so a checkout at the wrong
commit produces failures in packages that are not the cause, and the person who pulls
cannot tell.

This has cost time twice, in both directions:

- **Stale checkout.** A compiler six commits behind lacked `51e8cb9` (`string +=`
  emitted `f64.add`). `wactest` and `gzip`'s wac-written tests failed with
  `CompileError: f64.add[0] expected type f64, found struct.get` — a message that
  points at those packages and mentions nothing about compiler versions. Twenty minutes
  went into the wrong package before pulling `wac` fixed it.
- **Fresh checkout.** After `e64e47d` (an enum has no default value), `packages/wacc`
  stopped compiling. The suite was red for anyone who pulled, and the failure looked
  like wacc's until you knew about the compiler change.

Both were real and neither was the fault of the package that failed.

## Reproduction

```sh
cd ~/<agent>/workspaces/wac && git checkout HEAD~10
cd ../wac-mono && deno task test
```

Failures appear in whichever packages happen to use the affected feature.

Expected: something says "this repo expects wac at or after X", or the failure names
the compiler.
Actual: nothing records the expectation.

## Notes

Cheapest fix that would have caught both: record the expected commit and check it.
A `wac-version` file plus a few lines in `harness/wacBind.ts` — compare against
`git rev-parse` in the sibling checkout, or against a marker the compiler exports —
and fail with "wac-mono expects wac ≥ X, found Y" instead of a type error in someone
else's package.

That trades one maintenance chore, bumping the expected commit when adopting a
language change, for the failure naming its own cause. Given three agents pulling
independently, that looks worth it.

A weaker version costing nothing: a line in `README.md` under Commands saying to pull
`wac` first when a package fails to compile. That is not a fix, but it is where people
look.
