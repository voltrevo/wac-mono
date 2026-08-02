# zstd

Zstandard (RFC 8878) in wac. **Decoder, and only the frame layer so far.**

A package of [wac-mono](../../README.md) — see the root README for layout, the import map, and
how to run things. All commands run from the repo root.

## Status

**The decoder is complete for frames without a dictionary**, and is checked by decompressing
what zstd's own encoder produces and comparing bytes.

| Piece | State |
|---|---|
| Frame header, all field widths | done |
| Concatenated and skippable frames | done |
| Raw, RLE and compressed blocks | done |
| FSE (tANS) tables and bitstream | done |
| Huffman literals: both tree forms, 1 and 4 streams | done |
| Treeless literals, reusing the previous block's tree | done |
| Sequences: all four modes per code, and the repeat offsets | done |
| Content checksum (XXH64) | verified, not skipped |
| Dictionaries | **not implemented** |
| Compression | **started**: FSE encoding only — see below |

### What "not implemented" means here

**Dictionaries.** A dictionary supplies four things: a Huffman table for literals, the three FSE
tables, the three starting repeat offsets, and a window of content the first matches reach into.

*The decoder work is small*, and smaller than it looks, because `Decoder` in `src/block.wac`
already carries exactly those four fields — they are what a block inherits from the block before
it. Seeding them from a dictionary instead of from a previous block is the same operation, plus
parsing the dictionary format and pre-filling the history. Call it a couple of hundred lines.

*Testing it here is the actual obstacle.* Dictionaries come in two shapes, and they are not
equally reachable:

- a **raw content** dictionary is only history, and a frame using one **declares nothing** — it
  is indistinguishable from an ordinary frame. Node produces these, so they are testable, and
  the only reason ours are refused is that a match reaches back before the start of the output.
  That refusal is real but incidental: a frame whose matches never reach into the dictionary
  would decode correctly, which is only to say the dictionary was not doing anything;
- a **formatted** dictionary carries the entropy tables and an identifier, and that identifier
  appears in the frame header. Ours refuses any frame that declares one. Producing a formatted
  dictionary needs `zstd --train`, and the zstd CLI is not installed here — so the half of
  dictionary support that seeds entropy tables could be written but not checked against anything
  real, which by this package's standards is not finished.

*How much it matters* depends entirely on the use. For files, HTTP bodies and anything of
appreciable size, dictionaries are absent — none of the corpus in `test/decode.test.ts` uses one
and no ordinary encoder emits one unasked. They exist for the opposite case: many small messages
that share structure, where the shared part is longer than the message. If that is the use, this
package cannot serve it; if it is not, nothing here is missing.

**Compression.** `src/fseenc.wac` is the first piece: count normalisation, encoding-table
construction, the backwards bit writer, and table description writing. Nothing yet produces a
frame.

Why that piece first, and not literals: measured on this container, entropy-coding the literals
of a 102 KB prose sample gets it to 54 KB, while `zstd -3` gets it to 95 bytes. **Almost all of
zstd's compression is matches, not entropy coding** — so there is no useful milestone before
sequences, and sequences need FSE encoding. It is on the critical path from the start rather
than being a refinement.

What is left, in order:

1. **Sequences in Predefined mode.** The default distributions can express every literal-length
   and match-length code and offset codes up to 28, so a complete valid encoder can be written
   that never transmits an FSE table. Table construction and mode selection are both deferrable.
2. **Match finding.** `packages/gzip`'s LZ77 ports structurally — hash chains, chain limits, and
   the history-carrying trick added for streaming. Different window, different code tables, same
   search.
3. **Huffman literals**, which needs length-limited code construction, since zstd caps codes at
   11 bits and plain Huffman does not bound depth.
4. **Own tables and per-block mode selection** — Predefined against RLE against transmitted
   against Repeat, per code, per block. This is where a real encoder's quality lives.

The testing position is much better than the decoder's was. A decoder cannot be checked until it
decodes something whole, which is why the tests above lean on invariants; an encoder's very first
valid frame is checkable end to end, because Node must decompress it to the input.

### The normaliser is deliberately not zstd's

Counts have to be scaled to sum to exactly `1 << accuracyLog`. zstd distributes the rounding
error using a table of thresholds and falls back to a second algorithm in a corner case. Ours
rounds proportionally, gives every symbol that occurs at least one slot, and settles the
difference against the largest — correct, and readable in one sitting, at the cost of a fraction
of a percent of ratio. It also never produces the "less than one" count that the format allows
and the predefined tables use heavily, which is why `writeDescription` is tested against those
tables directly rather than against its own output.

## Why this order

Every field in the frame layer is a length or an offset, so getting one wrong moves everything
after it. A decoder that is wrong here fails later in ways that look like entropy-coding bugs,
and the entropy coding is the part where that is expensive to debug.

It is also the part that can be checked now. The tests are against frames Node's `zlib` produced
— zstd's own encoder, not a second reading of the specification — and where the encoder will not
emit what is needed, the frame is built by hand and **Node's decoder is asked to confirm it first**.
That caught a real mistake immediately: the two-byte content-size field is offset by 256, so it
tops out at 65791, and a frame built with it for 70000 bytes is invalid. A test that only compared
against my own decoder would have agreed with itself.

## What is left, in the order it should be done

The remaining work is one large piece and three that depend on it:

1. ~~**FSE**~~ — done, in `src/fse.wac`. See below for how it is checked without an oracle.
2. ~~**Huffman literals**~~ — done, in `src/huffman.wac`. What is left of it is *treeless*
   literals, where a block reuses the previous block's tree and sends no description at all —
   which needs the decoder to carry state between blocks, so it belongs with the block loop.
3. ~~**Sequences**~~ — three interleaved FSE streams for literal lengths, match lengths and offsets,
   each of which may be predefined, RLE, freshly transmitted, or repeated from the last block.
4. ~~**Sequence execution**~~ — copy literals, then a match, with the three repeat-offset slots and
   their reordering rules. Easy to get subtly wrong and easy to test differentially.

All done. XXH64 is in too, and the checksum is verified rather than stepped over.

Compression is a separate question and a much larger one: a valid encoder that only emits raw
blocks is nearly free, and one that competes with `zstd -3` is a project on the scale of everything
above put together.

## Testing FSE without an oracle

Nothing exposes "decode this FSE table" the way Node exposes zstd as a whole, so the checks are
indirect. Three of them, none of which is a second reading of the specification:

- **The Huffman completeness invariant, on real frames.** A frame's literals are Huffman-coded
  and the Huffman *weights* are FSE-coded. Weights are not arbitrary: `sum of 2^(weight-1)` must
  fall exactly one power of two short, because the remainder is the one weight that is not
  transmitted. Decode those weights wrongly by a single symbol or a single bit and the sum is
  almost never a power of two short. The test walks a real frame far enough to find the weights —
  header arithmetic only — and lets the invariant judge.
- **Round-tripping against a writer.** `test/writer.ts` writes table descriptions from chosen
  counts. Reading one back must build the same table as building it from those counts directly.
  This reaches shapes zstd's own encoder does not emit: long runs of unused symbols, tables made
  almost entirely of "less than one" symbols, and both ends of the accuracy log. 400 random
  distributions per run. A shared misreading would still agree, so it is a fuzzer rather than an
  oracle — but random bytes never once form a valid description, and this does.
- **The predefined distributions.** The format's default tables, built and checked for the
  properties a decoding table must have: every state names a real symbol, reads a possible number
  of bits, and lands inside the table for every value those bits can take, with each symbol
  holding exactly as many states as its count claimed.

Deliberately breaking the spread step, the bit width, the state order and the padding marker each
make these fail, which was checked rather than assumed.

Huffman gets a check of the same kind, and a sharper one. **Literals are a subsequence of the
block's content** — they are exactly the bytes no match covered, in order — so decoding real
frames and testing that property catches a symbol decoded wrongly, a symbol dropped, or a stream
read in the wrong direction. A weaker check like "the same set of bytes" would not. The section
header supplies two more constraints for free: how many literals there are, and how many bytes
they occupy. Breaking the rank widths, the code lengths, the span per symbol, the recovered last
weight, the four-way split and the jump table's endianness each make it fail — checked, again,
rather than assumed.

## How the whole decoder is checked

Once a compressed block decodes, Node's zstd becomes a real oracle: a frame goes in and the
original must come out, byte for byte. `test/decode.test.ts` does that over a corpus chosen for
the *codings* it makes the encoder reach rather than for realism — every literals kind, every
sequence-code mode, blocks of different kinds meeting in one frame, and every compression level
from 1 to 19.

The part worth stealing: **the test asserts which codings it reached.** Treeless literals and
Repeat-mode tables only appear once a file is large enough to have a previous block worth
inheriting from, and predefined tables only in blocks too small to transmit their own — so a
corpus can exercise a decoder thoroughly and silently never reach half of it. If a future
encoder stops choosing one, the test says so instead of quietly testing less.

## Layout

| path | what |
|---|---|
| `src/frame.wac` | frame headers, the block loop, raw and RLE blocks |
| `src/fse.wac` | FSE: table descriptions, table building, the backwards bitstream |
| `src/huffman.wac` | literals: tree descriptions, the decoding table, one and four streams |
| `src/sequences.wac` | the three interleaved codes, and the repeat-offset rules |
| `src/block.wac` | a compressed block: literals, sequences, and what carries between blocks |
| `src/xxh64.wac` | the content checksum |
| `src/fseenc.wac` | FSE encoding: normalisation, encoding tables, the backwards bit writer |
| `test/oracle.mjs` | Node's zstd, both directions, one subprocess per run |
| `test/frame.test.ts` | against encoder output, and hand-built frames Node validates |
| `test/fse.test.ts` | the three checks above |
| `test/huffman.test.ts` | literals as a subsequence, and the table build |
| `test/decode.test.ts` | whole frames against Node, and which codings were reached |
| `test/xxh64.test.ts` | the published vectors |
| `test/fseenc.test.ts` | encode, then decode with the decoder that reads real frames |
| `test/frames.ts` | walking a real frame to find its FSE-coded pieces |
| `test/writer.ts` | the description writer, for round-tripping |
| `cov.ts` | `deno task coverage:zstd` — 100% of branches |
