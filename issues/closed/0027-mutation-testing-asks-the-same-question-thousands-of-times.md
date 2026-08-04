# 0027 — mutation testing asks the same question thousands of times over constant tables

- **Status:** closed 2026-08-04, fixed in `tools/mutate/operators.ts` — one literal mutant per
  repeated statement shape, `--no-sample` to opt out
- **Reported by:** agent-b
- **Date:** 2026-08-04
- **Kind:** performance
- **Symptom:** no error

## What was wrong with this issue as filed

I filed it as "mutation testing has no notion of generated code", having just added a 1265-line
generated file to `packages/bls` and watched its `--operators=all` count go to 3862 against `ssh`'s
151. That diagnosis was too narrow in two ways, and counting before fixing is what showed it:

**Generated code was not the main cause, even in `bls`.** `fpkernel.wac` holds 1260 of the
package's ~3900 integer literals — a third. `map.wac` alone has 995, all hand-written: the
Frobenius tables, the isogeny coefficients, the SSWU constants. A cryptographic package is
constant-heavy by nature and would have had this problem without any generated file.

**`bls` was not even the worst case.** `packages/unicode/src/tables.wac` has **8792** integer
literals, seven times `fpkernel`'s, and had been quietly producing about that many mutants for as
long as `--operators=all` has existed. Nobody noticed because nobody had reason to look; I only
looked because I had made a smaller version of the same problem and gone looking for a per-file
breakdown.

So a fix scoped to generated files would have addressed a third of a third of the problem, and
`grep`-ing for `GENERATED FILE` would have felt like solving it.

## The actual cause

`--operators=all` bumps every integer literal by one. The repo has 28226 of them, and in the files
that dominate, mutating each in turn is *one experiment repeated*:

- a constant table asks "would anything notice a corrupted entry?" once per entry — 8792 times for
  `unicode`, 256 times for each of AES's two S-boxes
- unrolled arithmetic asks "would anything notice a wrong immediate?" once per limb — 144 times
  inside `montMul`

The same assertions decide every copy, so they all die together and 8791 of them told nobody
anything. This is the tool's own stated principle, from the top of `mutate/operators.ts`:
*"Adding operators past the point where survivors are still worth reading makes the report longer
and less useful — Google's finding was that unproductive mutants cost human attention, not machine
time."* Here it was costing both.

## The fix

`shapeKey` in `mutate/operators.ts` classifies each integer literal by the *kinds* of the four
tokens either side, scoped to the enclosing function or, at module level, the `const` being
initialised. At most three literals per class are mutated, chosen first/middle/last through the
class rather than the first three — a binary search notices a corrupted first key and may never
reach the five-hundredth, so three adjacent samples from the front of a 1459-entry table would be
worth little more than one.

The per-`const` scoping is load-bearing and was a bug in the first version: with everything at
module level sharing one scope, `unicode/src/tables.wac`'s six separate tables collapsed into a
single class of 8758 members and got three samples between them. Six tables are six questions.

Measured, per file:

```
packages/unicode/src/tables.wac    8787 literal mutants -> 47
packages/bls/src/fpkernel.wac      1221 -> 156
packages/crypto/src/blowfish.wac   1128 -> 130
packages/crypto/src/aes.wac         643 -> 119
packages/bls/src/map.wac            907 -> 223
packages/zstd/src/sequences.wac     403 -> 164
packages/sh/src/exec.wac            429 -> 416     <- logic, correctly almost untouched
repo total                        28226 -> 13376
```

That last row is the one that shows the rule is selective rather than blunt: `exec.wac` has 429
literals and keeps 416, because they are 353 distinct shapes — real, distinct constants in real,
distinct statements. Nothing was lost there.

End to end, whole-package sweeps:

```
--package unicode --operators=all    ~9000 mutants  ->  251 mutants, 3m33s
--package bls     --operators=all     3862 mutants  -> 1252 mutants
```

`--no-sample` restores the old behaviour exactly — verified, it returns bls to 3862 — for the
deliberate deep run where you want the survivor sampling might have hidden.

## What this trades away, stated plainly

**Sampling can hide a survivor.** The previous behaviour was merely slow; this one can miss a
finding that only the five-hundredth table entry would have exposed. That is why the sample is
three spread through each class rather than one, why `--no-sample` exists, and why the run prints
what it sampled:

```
literal: 13276 of 28226 integer literals mutated — at most 3 per repeated statement shape,
across 10406 shapes. Constant tables and unrolled code repeat one experiment; ...
```

That line exists because of 0024's lesson: `0/117 fell back` was read as good news for weeks. A
sweep that declines to ask a question must not look like one that asked and got an answer.

**The literal operator was not demoted, and should not be.** The obvious cheaper move was to drop
it from `--operators=all` entirely. The real `unicode` sweep says no: literal mutants *survive*
there — `literal/unicode/case:28:19/0→1` and others — and each survivor is a boundary nothing
checks. The operator is productive; it was the redundancy that was not.

## What is still open

This addresses mutant *count*. The other half of mutation-testing cost is *per-mutant* time —
measured at 2.24s wall for `bls`, and much worse for packages whose suites spawn subprocesses — and
that is **0024**, where subprocess coverage attribution is still open and is the only thing that
helps `sh` at 0/117 narrowed.
