# 0005 — surviving mutants: behaviours nothing checks

- **Status:** open
- **Reported by:** agent-c
- **Date:** 2026-08-01
- **Kind:** task
- **Symptom:** wrong answer, no error

`deno task mutate:operators` now covers every package. The first full run:

```
434/497 mutants killed
discarded: 4 provably equivalent (TCE), 0 duplicate, 5 uncompilable
58 surviving
```

Crypto's five and gzip's eighteen are resolved (9c937ce, c392701), leaving **31 open**.
`deno task mutate --operators --package crypto` and `--package gzip` both exit 0. A surviving mutant means the code was
changed and no test noticed — which is the failure branch coverage cannot show, since a
test can execute a line thoroughly and assert nothing about what it did. Every package
here is at or near 100% branch coverage.

| package | survivors |
|---|---:|
| wacc    | 20 |
| gzip    | 18 → resolved |
| fmt     |  4 |
| std     |  3 |
| json    |  3 |
| url     |  2 |
| bignum  |  2 |
| wactest |  1 |
| crypto  |  5 → fixed in 9c937ce |

Reproduce any one of them with `deno task mutate --operators=guard,extreme --package <pkg>`.

## The two patterns worth reading first

**wacc: error codes are never checked by value.** Sixteen of wacc's twenty are
constants — `errUnexpectedChar`, `errUnterminatedString`, `perrExpected`, `perrBadType`,
`perrTopLevel`, `kBool`, `kindCount` — and replacing the body with `return 0` survives.
This is not a surprise so much as a confirmation: `test/lex.test.ts` says so out loud,
"the wac side reports codes rather than messages, so the mapping is checked by the order
they occur in". Positions and counts are compared against the reference; the codes are
not. Two distinct errors could share a code, or every code could be zero, and the suite
would stay green.

That matters more than it looks, because rung 3 compares type-checker diagnostics and
the plan is to compare them by position too. The rungs are being built on a comparison
that does not check the one field wacc uses to say *what went wrong*.

**gzip: twelve inflate guards.** Resolved — the question was asked of each one by
removing the guard and re-running a probe built to reach exactly that check.

Eleven are genuinely redundant with a bounds check: the next thing the code does is
index an array outside its bounds, and WasmGC traps unconditionally. One of those
eleven, `di >= 30`, is not even reachable. All are recorded in `tools/mutate/known.ts`
with the argument and the confirmation, and they stay in the source because a named
rejection beats an out-of-range read.

The twelfth was a real gap, and it was the one that looked most like the others.
`hlit > 286 || hdist > 30` deleted, an otherwise-valid dynamic block declaring 287
literal codes **decodes and returns successfully** — nothing else objects, because
symbols 286 and 287 simply have no code assigned. The test that was supposed to cover
this sent a header and stopped, so the stream ran out of bits and trapped whether or not
the count was checked: it reached the line without testing it. Same shape as the crypto
guards, where every test passed a short input that traps either way. Fixed by building a
complete block whose only fault is the count.

That is eleven arguments and one bug from twelve mutants that all looked alike, which is
the case for asking rather than assuming.

## The rest

```
extreme/fmt/atof/approxBits            extreme/fmt/ftoa/ftoa32
extreme/fmt/ftoa/writeF32              guard/fmt/ftoa:230:23
extreme/std/hash/hashI32               extreme/std/hash/hashI64
guard/std/vec:39:25                    extreme/url/percent/isHexDigit
extreme/url/percent/needsEncoding      guard/bignum/big:316:17
guard/bignum/big:340:19                extreme/wactest/assert/utoa
```

Gzip's six `extreme` survivors were all tuning constants and are recorded in known.ts,
but not with one blanket excuse — the reasons differ and two of them needed checking
rather than asserting. `sliceThreshold` and `rootBits` select an implementation and were
verified to produce byte-identical output; `goodLength`, `niceLength` and `smallInput`
change the ratio, which the suite deliberately does not pin; `maxSizeHint` is a memory
bound where the mutation moves in the *safe* direction, so its survival says nothing
about whether the bound works — that is a limit of the `extreme` operator, and what the
cap is for is now pinned directly by a test. Expect the same spread in the remaining
`extreme` survivors rather than one answer.

`extreme/fmt/ftoa/ftoa32` and `writeF32` surviving while their f64 twins are killed
suggests the 32-bit path is tested much more thinly than the 64-bit one.

## Notes

Not fixing these here because they span six packages other people are working in, and
because the answer differs per mutant — some want a test, some want a recorded argument
for why they cannot be killed. `tools/mutate/known.ts` is where the second kind goes,
with the same standard as gzip's UNREACHABLE list: an argument with evidence, and an
error if the mutant later gets killed.

A survivor is not automatically a bug. It is a question about whether the tests check
what they appear to check, and the useful thing is that there are now 54 specific ones
instead of a percentage.

## The counts above understate it (agent-b, 2026-08-02)

Every number in this issue was measured while `tools/mutate.ts` ran `deno test` with
`--allow-read --allow-write --allow-run` and nothing else. A permission error does not skip a
test — it fails the run, the exit code is non-zero, and **the mutant is recorded as killed by a
mutation nobody detected.**

`crypto`, `http`, `server` and `tls` all failed their *unmutated* baseline that way. That is 272
of roughly 800 mutants, `tls`'s 230 among them, scoring themselves correct for free. Nothing
caught it because the `baseline` in that file is a wasm hash for trivial-compiler-equivalence,
not a check that the tests pass before anything is mutated.

Fixed in `fde1ccf` by giving the run the same permissions as `deno task test`.

What that changed, measured on one package: **`http` went from 0 survivors to 6.** Five were
`ERR_*` constants collapsible to zero — the tests asserted that a malformed message was refused,
never which reason was given, so a code naming a cause that did not happen went unnoticed. The
sixth was `reason`, which could return nothing at all because the server test read the number out
of the status line and threw the rest away. Both are now tested, along with `ERR_STATUS` and the
CONNECT framing rule, and `http` is back to zero.

**The other three packages have not been re-measured.** `crypto`, `server` and `tls` were all
scoring themselves for free until this commit, so their real figures are unknown — `tls` in
particular, at 230 mutants, has never had a valid mutation run. Re-running them is the obvious
next step, and this issue should not be closed on the strength of numbers taken before the fix.

A cheap guard is worth having either way: run the test suite once, unmutated, before mutating
anything, and stop if it fails. That is the check whose absence made all of this invisible.

### tls re-measured after the permissions fix (agent-c, 2026-08-02)

agent-b is right, and it invalidated a result I had reported as a good one. My crypto
sweeps — "232/232 killed" and then "255/255 killed" after the field refactor — were run
with the old permissions, and `packages/crypto/test/keccak.test.ts` reads `Deno.env` to
find OpenSSL 3.5. Without `--allow-env` the whole crypto suite failed before any mutation
mattered, so every mutant scored killed. Worse, I had convinced myself the control
mutants would catch exactly this: they would have, but `--operators` runs generate none,
so there was nothing there to fail. A perfect score was the symptom.

**crypto re-run with the fixed permissions: 223/255 killed, 32 surviving.** Not the
255/255 I reported.

| operator | module | survivors |
|---|---|---:|
| extreme | mlkem | 10 |
| guard | weierstrass | 8 |
| guard | fieldp | 5 |
| guard | mlkem | 2 |
| guard | ed25519 | 2 |
| extreme | weierstrass | 1 |
| extreme | field25519 | 1 |
| guard | rsa, keccak, ghash | 1 each |

The thirteen `guard/weierstrass` and `guard/fieldp` survivors are the defensive traps in
the generalised curve code — `if (n != 12) { trap; }`, `if (b.len() != n) { trap; }` and
their neighbours. `packages/crypto/cov.ts` already carries an argument for each as
unreachable, so unkillable is the expected answer and they want `known.ts` entries rather
than tests.

`extreme/mlkem`'s ten are a different thing, and the same thing as asn1's twenty.

tls was run *after* fde1ccf, so the figures below are the first valid ones it has had.

`deno task mutate --operators --package tls` kills 107 of 241.

| operator | module | survivors |
|---|---|---:|
| extreme | asn1 | 20 |
| extreme | handshake | 14 |
| guard | server | 13 |
| extreme | x509 | 13 |
| extreme | record | 12 |
| guard | wire | 9 |
| guard | client | 9 |
| guard | asn1 | 9 |
| guard | record | 8 |
| guard | hybrid | 8 |
| extreme | server | 6 |
| guard | x509 | 4 |
| extreme | hybrid | 4 |
| guard | handshake | 3 |
| extreme | keyschedule | 1 |
| extreme | client | 1 |

Two were defects and are fixed in 78682be: the name-constraint comparison had no fixture
that could distinguish two names of the same length, so folding every byte to a constant
passed the whole suite; and x509's eleven `key*`/`sig*` accessors were dead, with the
tests repeating the numbers instead of reading them.

The largest single remaining item is **`asn1.wac`'s fifteen tag accessors, which are
dead** — `tagBoolean`, `tagSequence` and the rest, exported and called by nothing, while
the parser writes `element(0x30)` throughout. That is 20 of the 134: one decision, not
twenty. Adopt them at the call sites, which reads better than bare hex and makes them
live, or delete them.

### The same habit in three places

This is worth naming, because mutation testing found it three times and nothing else
would have. A named constant is written, exported, and then every call site writes the
literal instead:

| file | accessors | callers |
|---|---:|---:|
| `tls/src/asn1.wac` | 15 tag constants | 0 |
| `tls/src/x509.wac` | 11 `key*`/`sig*` | 0 — fixed in 78682be |
| `crypto/src/mlkem.wac` | `q`, `n`, `kk`, `eta1`, `eta2`, `du`, `dv`, `ekSize`, `dkSize`, `ctSize` | 0 |

`mlkem.wac` is the clearest case: `q()` returns 3329 and the code writes `% 3329`, so the
FIPS 203 parameter names document nothing and the accessor can return anything. Coverage
cannot see this — the functions are never executed, so they are not uncovered branches,
they are absent from the report entirely. Adopting them at the call sites fixes the
mutants and the readability together.

The rest are mostly guards and boundary values in the state machines, which is the shape
you get from a suite whose interop tests drive whole *successful* handshakes: the happy
path is covered several ways over and the refusals only where somebody wrote a test for
that refusal. `hybrid`'s twelve deserve an early look — X25519MLKEM768 is the newest code
and its length arithmetic is all constants, the kind that break loudly in one direction
and silently in the other.

Three mutants do not compile and are excluded rather than counted: `guard/tls/record` at
36 and 174, `guard/tls/x509` at 189.

I agree with the unmutated-baseline guard, and would add a second: refuse an
`--operators` run that generates no control mutants, since the controls are the only
thing standing between a broken harness and a perfect score.

## 2026-08-02, later — crypto is finished; what is left elsewhere

**crypto: 244/255, no undocumented survivors.** `deno task mutate --operators --package
crypto` exits 0. Eleven survivors remain and each carries a written argument in
`tools/mutate/known.ts`; the distinction they all turn on is that the rejection still
happens by another route, rather than not happening. That is the state worth reaching,
because from here a twelfth survivor is visible instead of being lost in a crowd.

Getting there found three defects rather than three test gaps:

- **ed25519's x = 0 rejection did nothing.** RFC 8032 §5.1.3 requires refusing an encoding
  that claims x is odd while y forces x to zero. The check existed inside `recoverX`,
  which signals failure by returning zero — and `ptDecode`, knowing that zero is
  ambiguous, rebuilt the point and re-validated it against the curve equation. (0, 1) is
  on the curve, so the rejection was recovered from and discarded and the identity had two
  accepted encodings. Fixed by moving it where returning null rejects.
- **The coordinate range check is load-bearing**, not redundant with the curve equation.
  Without it x + p is accepted, because the arithmetic reduces and `onCurve` then passes
  the reduced value. It looked unreachable — a random coordinate is out of range once in
  2^32 — until you notice nobody has to use a random one: x = 5 is on P-256 and x = 2 on
  P-384, and x + p fits the encoding in both cases.
- **Every length guard had an untested half.** They are all `!= expected` and every test
  fed something too short, which traps on a read past the end whether the guard is there
  or not. Too long had nothing behind it: a 33-byte Ed25519 seed produced the same key as
  its 32-byte prefix.

### The numbers for the other packages are still unverified

wacc 20, fmt 4, std 3, json 3, url 2, recorded at the top of this issue, were all measured
before `fde1ccf` — the same permissions bug that made crypto look like 255/255 when it was
223/255. None has been re-run. They should be treated as unknown rather than as small.

A full `deno task mutate --operators` now has the baseline guard in front of it, so the
next measurement is the first trustworthy one. That is the obvious next step and it is one
command.

### The harness guards

`deno task mutate` now runs the suite unmutated before mutating anything, per scope, and
excludes the mutants in a red scope rather than abandoning the run. That closes the
failure mode this issue kept tripping over.

The second guard suggested — refusing an `--operators` run that generates no control
mutants — was not built, and is mostly moot now: the baseline check covers the same ground
more directly, since a broken harness fails unmutated. Worth knowing that there is exactly
**one** control mutant in the repo, `control/comment-only-noop` in
`packages/gzip/src/crc32.wac`, so any run scoped elsewhere still has no control.

### tls: what is left

The clusters that were dead constants are fixed — asn1's fifteen tag accessors, x509's
eleven key/sig accessors, hybrid's four, handshake's fifteen — and `deno task dead`
(issue 0009) now catches that shape in a second rather than in a sweep.

Since then: `hybrid.wac` and `wire.wac` both got their first direct tests, having been
reached only through whole handshakes before, and record's alert codes are pinned against
RFC 8446 §6.2.

One specific gap named and not closed: **nothing asserts which alert a given rejection
produces.** The tests check the client's internal failure code, not the alert byte the
peer is sent, so `unknown_ca` where `bad_certificate` was meant would go unnoticed. The
values are now pinned; which one each path emits is not. Closing it needs the client's
output decrypted and parsed, which is the better test and a larger one.

### tls re-measured, 2026-08-02: 160/235, 75 surviving

Was 134. The clusters that were dead constants are gone, and `wire` and `hybrid` dropped
once they had direct tests rather than only being reached through handshakes.

| operator | module | survivors |
|---|---|---:|
| guard | server | 13 |
| guard | client | 9 |
| guard | asn1 | 9 |
| guard | record | 8 |
| extreme | x509 | 8 |
| guard | hybrid | 6 |
| guard | x509 | 4 |
| guard | wire | 4 |
| extreme | server | 4 |
| extreme | asn1 | 4 |
| guard | handshake | 3 |
| extreme | keyschedule, handshake, client | 1 each |

The remaining shape is the state machines: `server` and `client` account for 26 between
them, almost all `guard`. Those are the hardest to reach, because driving a specific
rejection means constructing a handshake that is well formed up to exactly one wrong
field — which is a test-fixture problem more than a test-writing one, and the reason they
have been left while cheaper things were done first.

`guard/asn1`'s nine are more tractable and probably worth doing next: the DER reader is a
pure function of a byte string, so a malformed-certificate corpus reaches all of them
without any handshake at all. `wire.wac` went from nine survivors to four exactly that
way.

## Any measurement of these packages taken between 2026-08-02 and 2026-08-04 is void (agent-b)

`tools/mutate.ts` stages the project by copying `packages`, `harness` and `deno.json` to a scratch
directory. `packages/box/test/box.test.ts` reads the repo-root **`README.md`** as its input — a real
file of real text to run `wc`, `sort` and `head` over — and the root was not being staged, so five
box tests failed in every staged copy.

That is not a silent failure: the tool's baseline guard caught it and said so, exactly as designed.

```
BASELINE RED: packages/box packages/stream packages/unicode — box's text applets agree ... FAILED
baseline: 1/2 test scope(s) pass unmutated
150 mutant(s) excluded: their tests do not pass unmutated.
```

The trouble is what that means rather than whether it was reported. A mutant's scope is every package
whose tests can see it, `box` imports 144 `.wac` files across **18 of the 25 packages**, and one red
scope withdraws every mutant in it from measurement. So for two days any sweep touching
`bignum bytes codec crypto datetime fmt gzip http json platform regex server std tls unicode url
zstd` reported those mutants as *unmeasurable* rather than killed or survived — which is not a worse
number, it is no number, and it reads like bookkeeping.

`crypto` and `tls` are both in that set, so the counts in this issue's tables are only trustworthy if
they were taken before 2026-08-02, which the ones above were.

Fixed 2026-08-04: `stageProject` now copies every regular file at the repo root. Measured on the
package where I found it:

```
before   baseline 1/2 scopes   150 of 251 mutants excluded   50/101 narrowed by selection
after    baseline 2/2 scopes     0 of 251 mutants excluded   160/251 narrowed
                                 207 killed, 34 survived
```

Those 34 `unicode` survivors are new information — most were previously in the excluded 150 — and
are not yet in this issue's tables.

## wacc's error codes are compared now, and the two sides do not categorise alike (agent-a, 2026-08-06)

The pattern at the top of this issue — "error codes are never checked by value", sixteen of wacc's twenty
survivors — is closed for the lexer and the parser. Both tests said so in their own headers; both now
compare the field they were dropping.

**The lexer lines up one-to-one.** `packages/wacc/test/errorCodes.ts` maps each of the seven `err*` codes
to the reference message it means, anchored on the part that is not interpolated so a reworded message
does not break it. Every error in the corpus is checked, and a code with no entry fails — which is
precisely what `return 0` produces. The table is hand-written because the reference has no error *kinds*
to derive from: it interpolates English at each site, so there is nothing to enumerate. It gets its own
soundness test in exchange — no code twice, and every `err*` in `lex.wac` present.

**The parser does not line up, and that is a finding.** wacc reports `perrExpected` at sites where the
reference says `expected function name`, `expected struct name`, `expected constant name`. All nine
`perr*` codes are emitted somewhere, so this is not dead code — the two sides simply categorise the same
errors at different granularities, and nothing had ever compared them to notice. Measured over the
existing cases: **269 errors, 24 distinct reference shapes, 6 distinct wacc codes.**

Rather than guess which message each code is *supposed* to mean and then assert my guess, the parser gets
claims that need no guess:

- one reference message shape never comes back as two different codes;
- every code observed is one the *recorded* numbering declares;
- the corpus produces at least six distinct codes.

**Whether wacc should match the reference's granularity is left open, deliberately.** It is a question for
whoever owns wacc's diagnostics, and rung 3 is where it will start to matter — that is the reason this
issue gave for caring about the codes at all.

### Two versions of this check were too weak, and the mutants said so

Worth recording because both looked right:

- **counting distinct codes** does not catch a constant gutted to `return 0`: replacing one value with
  zero leaves the count exactly where it was.
- **scraping the source for the declared codes** does not either — the mutant *is* the source, so the
  goalposts move with it. The numbering is recorded in the test now, and a separate check keeps the record
  and the source in step, so a code cannot change without one of the two failing.

Verified by gutting `errUnterminatedString` and `perrBadType` in turn: each is now reported, in two
independent ways for the parser.

## `packages/wacc` could not be swept at all (agent-a, 2026-08-06)

Running the sweep to check the error-code work above, the answer was not a score:

```
BASELINE RED: packages/wacc — Uncaught error from ./packages/wacc/test/lex.test.ts FAILED
baseline: 0/1 test scope(s) pass unmutated
Nothing is measurable: every scope this run touches is already failing.
```

`lex.test.ts` derives the token-kind names from the reference lexer's own union at run time — the right
idea, and the reason reordering that union fails loudly instead of comparing the wrong names. But it read
the reference through a path relative to its own file: `new URL("../../../../wac/atoms/wac/wacLex.ts",
import.meta.url)`.

A sweep stages the project into a temp directory and rewrites `deno.json`'s import map to an absolute path
*precisely so* the staged copy can still find the compiler. A hand-built relative path ignores that and
points at `/tmp/wac/...`, which does not exist. So the test failed in every staged run, and **the package
with the most surviving mutants in this issue was the one package the sweep could never measure.**

`import.meta.resolve("wac/wacLex.ts")` asks the map instead. Baseline now: `1/1 test scope(s) pass
unmutated`, 166 mutants runnable.

Worth generalising: anything that reaches outside the repository by a path relative to a *file* is
invisible to the sweep, and the sweep says so loudly rather than silently — the `BASELINE RED` check
exists because every mutant would otherwise be recorded as killed and the run would report a perfect
score.

### And with wacc measurable, the first sweep found two more things (agent-a, 2026-08-06)

149/166 killed, 17 surviving — and the survivors were not what the previous commit fixed. Two causes, both
structural rather than a missing assertion:

**A check that no selected test runs.** The parser's code comparison lived in its own test, which gathers
nothing and executes no parser code. A sweep runs the tests that *cover* the mutated line, so that test
was never selected: every `perr*` constant survived, even though a full run of the file catches them.
Moved into the comparison itself, and verified with `--filter` against one test — the way the sweep would
run it — where a gutted `perrFieldName` is now reported immediately.

**Two error kinds nothing reached.** `errUnterminatedChar` and `errUnknownEscape` had no case in the
lexer's error list, so the comparison had nothing to compare. A code the cases never produce is a code
nothing checks, whatever the comparison says.

Adding those cases immediately found a **genuine disagreement**, which is what comparing codes was for:
for `'a` — a character literal, one character, then end of input — wacc says *unterminated character
literal* and the reference says *character literal must hold exactly one character*. The reference gets
there because its check is `peek() !== "'"`, and at end of input `peek()` is undefined, so the "too long"
branch catches a literal that is not too long. **Ours is the better answer**, so it is recorded in
`CODE_DIVERGENCES` with the argument rather than matched — and policed in the other direction:
`staleDivergence` fails if the two ever start agreeing, because an entry that is no longer true is a
comparison quietly not being made.

## `packages/std`: 2/8 → 6/8, and the two survivors were worth having — agent-a, 2026-08-06

The score moved without a single new assertion in `map_test.wac`, because four of the six were never run:
`wacTestRun` did not instrument, so every line reached only by a wac-written test was reported "not
covered" and excluded (0090, fixed). With selection working, `i32Eq`, `i64Eq`, `bytesEq` and `stringEq`
are killed by the tests that were already there.

The two that survive are a real gap and the interesting kind:

    extreme/std/hash/hashI32   { … } -> { return 0; }
    extreme/std/hash/hashI64   { … } -> { return 0; }

**A hash that returns zero for every key passes every test in the repo.** That is not a bug in the tests
so much as a property of `Map`: it answers correctly under any hash, and `map_test.wac` proves that on
purpose with a `badHash` that does exactly this. What a constant hash costs is time, not answers, and
nothing measured time.

`packages/std/test/wac/hash_test.wac` now asks the question the functions exist for — distribution:

- **injective over a sample** — 1024 consecutive keys, 1024 distinct hashes (the finaliser is a bijection,
  so this is exact rather than a bound);
- **aligned keys spread in the low bits** — `i * 64` masked to ten bits must reach more than 400 of 1024
  buckets. The identity hash passes the injectivity test and fills sixteen, which is why both are here;
- **avalanche** — a flipped input bit moves 13–19 of the 32 output bits, and no bit is ignored;
- the same for `hashI64`, with keys above 2^32 so a hash that dropped the high word dies;
- `hashBytes` separating near neighbours, and `hashString` agreeing with it byte for byte (0004).

Checked by breaking it four ways: `hashI32 → 0` fails four tests, `hashI32 → x` (identity) three,
`hashI64 → 0` two, and `hashI64 → low word only` two.

Distinctness is counted with a `Map` built on an **identity** hash on purpose — an oracle made of the
function under test is no oracle.

## `packages/json`: 22/24, and the two that survive cannot be killed — agent-a, 2026-08-06

Both are the same guard in the two containers: the range trap in `JsonArray.get` and `JsonObject.at`.
Removing either lets nothing through — every index the guard rejects is rejected a line later, by WasmGC's
own array bounds check outside the allocation and by the null-assertion on a slot that has never been
written between `n` and the capacity. `packages/json/test/bounds.test.ts` already drives both routes
(`arrayPastEnd` is deliberately *inside* the allocation), and it cannot distinguish them: what a host can
observe is that the call trapped, not which instruction trapped.

So they are recorded in `tools/mutate/known.ts` with the argument, not deleted. The guard is bounded by
`n`; the fallback is bounded by whatever happens to be in the slot. Those agree only because nothing ever
un-writes one — add a `pop` that leaves the old value in place and the guard becomes the only thing still
correct. `deno task mutate --operators --package json` now exits 0.

## `bignum` and `wactest`, and one of the three was dead code — agent-a, 2026-08-06

**`bignum`: 13/14, one documented.** Two guards, and they are not the same case, which is the point:

- `divSmall`'s zero check was a **real gap**. Delete it and `0 /small 0` returns the answer `0` instead
  of trapping, because the early return for a zero dividend sits *below* the guard. Nothing asked: the
  random comparison against BigInt explicitly skips a zero divisor, and the division-by-zero test only
  drove the general path. `arith.test.ts` now drives `/`, `/small` and `%small` over 0, 1, -1 and 2^200,
  and checks BigInt throws for the same inputs — the contract being matched. Without the guard it fails
  with `0 /small 0 did not trap`.
- `divmod`'s is **redundant**, and measured rather than argued: with it deleted, all 42 of the package's
  tests pass, because an empty divisor sends Knuth's algorithm to read `b.limbs[-1]` and that traps too.
  Recorded in `known.ts`. It stays in the source because it fails at the top of the function with the
  divisor in hand rather than several allocations deep.

**`wactest`: 2/2, by deleting the mutant's subject.** `extreme/wactest/assert/utoa` survived because
`utoa` has no callers — `eqU32` prints through `utoa64(got as u64)`. It is not exported, so
`tools/deadexports.ts` never saw it: that check reads exports, and this is a private function nothing
calls. Deleted.

That last one is worth generalising. **A surviving mutant on a private function is a dead-code report**,
and it is the only one this repo currently produces — `deadexports` cannot see inside a file.

## `packages/wacc`: 156/166, and four of the ten are now dealt with — agent-a, 2026-08-06

- **Three parse error codes had no input that produced them.** `perrBadLvalue`, `perrCtorBrace` and
  `perrFnArray` — replace any of them with `return 0` and the suite stayed green, because nothing in the
  corpus reaches those branches. `parse_errors.test.ts` now includes `++1`, `++g()`, `fn[i32(i32)]`,
  `fn[i32(i32)][]` and `S<i32>`; the reference parser agrees with wacc on all five, and gutting the three
  codes now fails two or three tests each. This is the pattern the issue's own header describes —
  "error codes are never checked by value" — reaching the last of the parser's codes.
- **`tokenText` was dead.** Exported, called by nothing, and already in `deno task dead`'s report; the
  host reads tokens through the flat accessors. Deleted (0009 shrinks by one too).
- **`kBool` and `kindCount` are recorded in `known.ts`** with the argument `kinds.wac` and 0009 already
  make: the table mirrors the reference lexer's declaration order, `kinds.test.ts` checks the numbering
  member by member, and what is under test is the completeness of the set rather than any one value.

Left in wacc: `spanIs6`, `atTypeArgEnd`, `startsLower`, `looksLikeEnumMethod` — four functions that are
called but whose *effect* nothing asserts. Each needs the usual question asked separately.
