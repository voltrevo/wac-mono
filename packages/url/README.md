# url

A WHATWG URL parser: parse, serialize, and resolve a reference against a base.

```wac
import { Url, parseUrl, serialize, pathname, hostname } from "../../url/src/url.wac";

Url? base = parseUrl("http://example.com/a/b?q#f".toBytes(), null);
Url? u = parseUrl("../c".toBytes(), base);
string href = string.fromBytes(serialize(u!));   // "http://example.com/c"
```

## Why it is a package

Because the oracle is exact and total. For any input at all, a conforming URL implementation
either produces a URL whose nine components are readable or rejects it — so every test is a
comparison and none of them is an opinion. That is the same property that made `json` and
`bignum` worth writing.

It is also the next rung of the stack: an HTTP client needs URLs before it needs anything else.

## The oracle turned out to be two oracles

`new URL` was supposed to be the oracle. It is not one thing. **Deno's URL and Node's disagree**,
and neither is right everywhere:

| input | Deno | Node | standard |
|---|---|---|---|
| `file:///c\|/x` | `file:///c\|/x` | `file:///c:/x` | Node — the path state normalises a drive letter |
| `file:////a` | `file:///a` | `file:////a` | Node — the third slash is the empty host, the fourth an empty segment |
| `\d` against `foo://host/p` | `foo://host/d` | `foo://host/\d` | Node — `\` separates only for a special scheme |
| `..` against `foo://host/p` | `foo://host/` | `foo://host` | Deno — double-dot appends `""`, so the path is `[""]` |
| `a#f` against `foo:opaque` | rejected | `foo:opaque/a#f` | Deno — a reference resolves against an opaque path only if it starts with `#` |

Node parses with Ada and is right more often, but that last row is not close: appending to an
opaque path is something the standard forbids in one sentence.

So the oracle is **where the two agree**, which is 94% of generated cases and has no case where
both are wrong the same way. The disagreements are handled two ways, and neither is "skip":

- The hand-picked ones are asserted against the standard's own text, quoted per case in
  `DIVERGENCES` in `test/url.test.ts`. If a runtime is ever fixed, the test fails and says the
  entry can go — which a comment would not.
- In the fuzzer they are excluded and **counted**, and the test fails if they exceed 15% of a
  run. A generator change that pushed most cases into the disagreement bucket would otherwise
  leave every remaining comparison passing while testing almost nothing.

That whole structure exists because the first version of this package quietly matched whichever
runtime was running the tests.

## Tests

| file | what it pins |
|---|---|
| `test/url.test.ts` | ~200 hand-written cases across every component, plus the divergences judged against the standard |
| `test/fuzz.test.ts` | 10 000 inputs assembled from URL-shaped fragments, against runtime agreement |
| `test/wac/url_test.wac` | the parts no input reaches: the component encode set, IPv6 compression, `endsInNumber` |

`deno task coverage:url` reports 94%, with `url.wac` at 98%.

`deno run -A packages/url/tools/diff.ts '<input>' ['<base>']` prints wac's answer beside the
host's, field by field. It is the loop this was written in.

### The bug that was not in this package

The first fuzz run disagreed on almost everything, and the cause was in `packages/bytes`:
`Buf.take()` documented that it empties the buffer, and only did so when the buffer happened to
be exactly full. Every other length took the copy path, which left the contents in place. No
caller had noticed because every caller in the repo took once and dropped the Buf; this parser
reuses one across a parse, so its scheme ended up glued to the front of its path. Fixed there,
with a regression test that was verified to fail without the fix.

Worth stating because it is the third time in this repo that a *documented* invariant and the
code disagreed and only a new consumer noticed.

## Not implemented

- **IDNA.** A non-ASCII domain should be mapped through UTS-46 ToASCII, which needs Unicode
  tables; it is rejected instead. This is the one deliberate divergence from the standard, and
  it is asserted rather than skipped: a test checks that these are still rejected and that
  already-punycoded domains still agree, so the day it lands, or the day the boundary moves,
  something says so.
- **Setters.** The standard's parser takes a state override so that `url.host = "..."` can
  re-enter it mid-way. Nothing here mutates a parsed URL, so there is no state override.
- **`searchParams`.** Form encoding is a separate algorithm and belongs in its own file.
- **Percent-decoding a URL back to text.** `decode` exists in `percent.wac`, but there is no
  "give me the pathname as text" convenience, because the answer is not always valid UTF-8.

## Shape

**Bytes throughout.** The standard is written over code points; this works on UTF-8 bytes. The
difference shows up in exactly one place — a byte-wise loop cannot see a lone surrogate, and
UTF-8 input cannot contain one — and percent-encoding is defined byte-wise anyway.

**A host is three cases, not five.** `Named` covers a domain, an opaque host and the empty host,
because they differ in how they are parsed and validated but all serialize as their own bytes.
`Ipv4` and `Ipv6` are separate because they do not: `0x7f.1` serializes as `127.0.0.1` and
`[0:0::1]` as `[::1]`, so the input form is not recoverable and must not be kept.

**The state machine is written to be read against the standard.** Same state names, same order,
the odd cases odd in the same way. A divergence should be findable by reading the two side by
side, which is worth more here than any cleverness would be.
