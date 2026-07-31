# codec

Base16, base32 and base64, from RFC 4648. Both base64 alphabets, both base32 alphabets, padded
or not.

```wac
import { encode, decode, ALPHABET_URL } from "../../codec/src/base64.wac";

u8[] text = encode("hello".toBytes(), ALPHABET_URL(), false);   // "aGVsbG8"
u8[]? back = decode(text);                                      // null if malformed
```

## Why it is a package

Because `http`, `crypto` and `url` all want it and none of them should own it, and because RFC
4648 ships **normative test vectors** — which is a stronger oracle than an implementation. An
implementation can be wrong; the vectors define what right is. Every row of the §10 table is in
the tests, for every encoding it covers.

## Decoding is strict, and the platform's is not

This is the decision worth knowing before using it. `atob` and Node's
`Buffer.from(s, "base64")` accept input RFC 4648 rejects. This rejects it, on four counts:

- **A group of one digit.** One base64 digit carries six bits and a byte needs eight, so `A` is
  not a short encoding of anything.
- **Padding that does not fit.** `A===`, `AB=A`, a lone `=`. Padding is the last thing or it is
  an error.
- **Unpadded input at an impossible length.** Unpadded is fine; unpadded at 4k+1 digits is not.
- **Non-zero unused bits.** `QQ==` decodes to `A`; `QR==` does not decode at all, because the
  four bits `R` contributes past the byte are not zero.

That last rule is the one every lenient decoder drops, and the one that makes an encoding a
function rather than a relation. Without it `QQ==`, `QR==`, `QS==` and thirteen more all decode
to `A` — so a signature over the text says nothing about the bytes, and two systems can disagree
about whether two messages are the same. It costs one comparison.

Nothing is skipped, either: whitespace is not ignored. "Ignore whitespace" is a decision the
caller should make explicitly rather than one a decoder makes for everybody, and a caller who
wants it can strip before calling.

Consequence for the tests: **the platform's decoder is not a valid oracle**, so the differential
tests compare *encoders* only, where `btoa` produces the same canonical output this does. The
rejections are asserted directly instead, each with the reason it is wrong.

## Tests

| file | what it pins |
|---|---|
| `test/codec.test.ts` | the RFC 4648 §10 vectors both ways; encoding against `btoa` and a hex reference over random input; round-trip at every length to 300; the strictness suite |

`deno task coverage:codec` reports 100%.

Getting to 100% found dead code twice, which is the usual reason to bother: the pad-count checks
in both `base64` and `base32` were unreachable, because the length test above them already forces
the pad count — the digit count determines it. Both are gone, with the argument written where they
were.

## Not here yet

- **base64 streaming.** Everything takes and returns a whole array. A streaming decoder wants a
  carry of up to three digits across calls, which is a different interface, not a different
  algorithm.
- **Ignoring whitespace on request.** Deliberately absent rather than forgotten — see above. A
  `decodeLenient` would be easy and should be a separate, obviously-named function.
- **base64 for text.** Everything is bytes. Encoding a `string` means choosing UTF-8, and that
  choice belongs to the caller.
