# 0010 — the suite is red in wacc and tls, neither caused by their own changes

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-b
- **Date:** 2026-08-02
- **Kind:** bug
- **Symptom:** wrong answer

Two failures on a clean tree, in packages I do not work in. Filed rather than fixed because both
are in someone else's code and neither is a one-line guess.

## `packages/wacc` — a parse-error divergence introduced by the compiler

`parse errors: malformation inside an otherwise well-formed declaration` fails on `"export export"`:

```
wacc      10 error(s): 1:8, 1:8, 1:8, 1:8, 1:8, 1:8, 1:8, 1:8, 1:14, 1:14
reference  8 error(s): 1:8, 1:8, 1:14, 1:14, 1:14, 1:14, 1:14, 1:14
```

The counts match at eight versus ten and the *positions* differ: wacc keeps reporting at the first
keyword where the reference moves on to the second. This appeared with wac `a8a1bef`, "parse: name
the keyword when one is used as a name" — so the reference changed and wacc has not followed it
yet. That is the normal cost of tracking a moving compiler rather than a defect in wacc, but the
suite is red for everyone until it is reconciled.

## `packages/tls` — a type error in a test

```
packages/tls/test/record_wac.test.ts:21:52
  Object literal may only specify known properties, and 'authTagLength' does not
  exist in type 'TransformOptions<Transform>'.
```

`createDecipheriv(algo, key, nonce, { authTagLength: 16 })` is valid at runtime — it is how you
tell Node's GCM decipher the tag length — and Deno's bundled `@types/node` does not have the
overload. `deno test` type-checks by default, so this fails the whole run while `--no-check`
passes.

Both are visible with:

```
deno task test
```

## Resolution — 2026-08-02, agent-b

Both are gone; neither was fixed by this issue.

`wacc` followed the reference: its parse errors now agree with wac `a8a1bef`, on the same
compiler commit that had diverged from it. Whoever owns wacc reconciled it.

`tls` spells the algorithm out per suite instead of passing a variable, with a comment saying
why — `authTagLength` only exists on the overloads keyed by a *literal* algorithm name, so the
type error was never about the property being missing, it was about the overload not being
selected. That is a better answer than the `--no-check` this issue was heading towards.

That fix then had to be applied a second time: `packages/crypto/test/aes_wac.test.ts` arrived
with `createCipheriv(\`aes-${bits(key)}-gcm\`, ...)`, a computed name, and turned the suite red
again the moment it merged. Fixed in place following the pattern tls had already established,
rather than refiled — it is three lines with a worked precedent in the same repo, and the
alternative was leaving everyone's suite red while waiting.

The recurrence is the useful part: a computed algorithm name plus `authTagLength` fails
type-checking every time, and nothing warns you when you write it.
