# unicode

UTF-8 as code points, and simple case mapping.

```wac
import { Scalar, decode, isValid } from "../../unicode/src/utf8.wac";
import { toLower, toUpper, fold, foldEqual } from "../../unicode/src/case.wac";

bool same = foldEqual("ΣΊΣΥΦΟΣ".toBytes(), "σίσυφος".toBytes());   // true
i32 lower = toLower(0x0130);                                       // İ has no simple lowercase
```

## The tables come from the host

The host already carries a Unicode database — that is what `toLowerCase` consults — so
`tools/gentables.ts` enumerates every code point, asks it, and emits `src/tables.wac`: three
sorted arrays of the ~1,450 code points whose mapping differs from themselves, and a binary search
over them.

This is the same move as `packages/codec`, where RFC 4648's own vectors are the oracle: **derive
the data from the authority, then check the result against that authority from the other
direction.** It also means there is no `UnicodeData.txt` in the repo to go stale — regenerating is
`deno task gen:unicode`, and the tests fail if the generated tables and the host disagree.

Checking generated tables against the generator's source looks circular, and for the mapping
*values* it partly is. What the tests actually establish is not:

- **the lookup is right.** A binary search over 1,482 sorted pairs is exactly the code that is
  off by one at the ends, and the generator has no opinion about it;
- **the boundary is where it is claimed to be.** The test enumerates every code point the host maps
  to *more than one*, and requires simple mapping to leave each alone — rather than assuming there
  are none;
- **UTF-8 is right**, judged by `TextEncoder` and a `fatal: true` `TextDecoder`, neither of which
  the generator touched.

Every code point, 0 to 0x10FFFF, on every run.

## Simple mapping only

One code point in, one out. Full mapping — `ß` to `SS`, `ﬁ` to `FI`, the Turkish dotted and
dotless `i` — changes the length of the text and depends on locale and context. A function that
silently did some of that and not the rest would be worse than one that does none.

So where the host's mapping is more than one code point, the code point is left alone, and the
tests say exactly which ones those are.

**Folding is `lower(upper(x))`, not `lower(x)`**, and that is not a detail. Greek `Σ` lowercases to
`σ` at the start of a word and `ς` at the end — a *contextual* form. A fold derived from lowercase
alone leaves `ς` as itself, so `ΣΊΣΥΦΟΣ` and `σίσυφος` compare unequal. Going up first collapses
both sigmas, and coming back down gives one answer. It cost a test failure to find.

## UTF-8 is strict

An over-long encoding, a surrogate, or a value past U+10FFFF is a decoding **error**, not a
U+FFFD. The argument is `codec`'s: a decoder that substitutes turns "these bytes are not UTF-8"
into "these bytes are some other text", and two systems that both substitute disagree about what
the text was. `isValid` is checked against a `fatal: true` `TextDecoder` over hand-picked
malformations and 5,000 random byte strings.

`deno task coverage:unicode` reports 98%.

## What this closed, and what it did not

**`regex` now has an `i` flag**, agreeing with `RegExp` over ASCII. The folding is done at
*compile* time — each literal and class range is expanded to cover both cases — so the machine is
untouched and the hot path has no table lookup.

It is ASCII only, and that is a real limit rather than an oversight: `regex` matches **bytes**, so
folding a non-ASCII letter would mean folding half of a multi-byte scalar. The tables here are
what a code-point-aware matcher would use, and that is a different engine.

**`url`'s IDNA gap is still open.** UTS-46 needs a mapping table this could generate, but it also
needs NFC — see below.

## Not here yet

- **Normalization (NFC/NFD).** The host exposes `String.normalize`, so decomposition mappings can
  be generated the same way. What it does *not* expose is the canonical combining class, and the
  canonical ordering algorithm needs it. It can be derived — normalize pairs of combining marks and
  see which ones swap — but that is a real piece of work and an O(n²) derivation, not an
  afternoon. Nothing else here depends on it; IDNA does.
- **Full case mapping**, which needs one-to-many tables and a locale argument.
- **Compatibility normalization** (NFKC/NFKD), a much larger table for a much rarer need.
- **Character properties** — category, script, `isAlphabetic`. Generatable the same way, and worth
  doing when something asks.
