# 0093 — eight private `slice`s, and they disagree about a bad range

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-a
- **Date:** 2026-08-06
- **Kind:** bug
- **Symptom:** wrong answer

Eight packages carry a private `u8[] slice(u8[], i32, i32)`. That much is ordinary duplication. What makes
it an issue is that **they have already drifted into four different answers for an invalid range**, so the
same call with the same arguments traps in one package, returns empty in another, and returns a short array
in a third.

| file | `from < 0`, `to > len` | `to < from` |
| --- | --- | --- |
| `packages/tor/src/microdesc.wac`, `packages/tor/src/relayd.wac`, `packages/ens/src/ens.wac` | traps | traps (negative length) |
| `packages/tls/src/x509.wac`, `packages/tor/src/hsdesc.wac` | returns empty | returns empty |
| `packages/ssz/src/container.wac` | traps on the read | returns empty |
| `packages/http/src/incoming.wac`, `packages/server/src/routes.wac` | traps on the read | returns empty |

Twenty-nine call sites between them.

## Why this is a decision rather than a patch

Which behaviour is right is not obvious, and the answer changes what callers may assume:

- **Trap.** A slice past the end is a bug at the call site, and this repo's stance elsewhere is that a gap
  should fail rather than be approximated. Moving `x509` and `hsdesc` to this would turn a currently
  swallowed bad call into a crash — which is the point, but it is a live behaviour change in a parser that
  reads attacker-controlled bytes, and "it now crashes on input it used to tolerate" is exactly the thing to
  decide deliberately rather than discover.
- **Return empty.** Total, and a parser can carry on — but a caller cannot tell "nothing there" from "your
  arguments were wrong", which is the conflation `packages/mpt`'s `ok`/`present` split exists to avoid.
- **Both, named.** `slice` that traps and `clamped` that does not, so the call site says which it means.
  Most likely right, and the most work: twenty-nine call sites have to be read rather than rewritten,
  because which one each wants is the whole question.

## Where it should live

`packages/bytes`, which is the leaf every one of these already depends on transitively.

## Note

Found while deleting five private `itoa`s for the same reason — those *had* drifted in a way that cost:
the i32-minimum bug was fixed in four copies separately (GitHub wac-mono#6), and two `packages/ssh` copies
still returned `""` for a negative until today. `slice` has not cost anything yet. It is filed rather than
fixed because the fix has to pick a semantics for other people's parsers, and picking wrong is expensive to
undo.
