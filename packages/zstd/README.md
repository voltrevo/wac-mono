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
| Compression | **works**: valid frames zstd decompresses — see below for how good |

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

**Compression.** `src/encode.wac` produces valid zstd frames — Node's zstd decompresses every
one of them back to the input, across a corpus and a fuzzer. It finds matches greedily, leaves
literals uncompressed, and codes every sequence with the format's predefined FSE tables, so it
never transmits a table of its own.

Where that lands on real data — `deno task bench:zstd`, over source in three languages, prose,
config, a wasm module, a native executable, Tor directory data, and something already compressed:

| sample | raw | ours | gzip -6 | zstd -3 | zstd -19 |
|---|---:|---:|---:|---:|---:|
| wac source | 1,014,867 | 284,753 | 283,810 | 288,004 | 233,786 |
| typescript | 1,048,576 | **287,426** | 294,001 | 292,769 | 238,497 |
| python | 1,048,576 | **229,034** | 238,783 | 241,915 | 193,448 |
| markdown | 252,668 | 98,243 | 96,694 | 98,376 | 85,273 |
| json | 357,128 | **2,947** | 3,479 | 2,833 | 2,574 |
| wasm | 12,746 | 5,856 | 5,392 | 5,499 | 5,065 |
| native binary | 1,048,576 | 184,976 | 181,087 | 169,378 | 147,203 |
| tor microdescs | 2,097,152 | **290,218** | 922,537 | 240,833 | 231,273 |
| tor consensus | 2,097,152 | 550,197 | 520,158 | 501,718 | 451,051 |
| gzipped source | 287,124 | 286,754 | 286,526 | 287,142 | 286,295 |
| **total** | **9,264,565** | **2,220,404** | 2,832,467 | 2,128,467 | 1,874,465 |

**22% smaller than `gzip -6` across the corpus, 4% larger than `zstd -3`.** We win on source code
in all three languages and lose on binaries and on Tor's directory data. Already-compressed input
does not expand.

### Speed

`deno task bench:zstd-speed`. Each side times itself, so neither figure includes the cost of
getting the data to the other process — but ours does include copying across the wasm boundary,
which a caller genuinely pays.

Both decoders are timed on the **same frame** — zstd's own output. Timing ours on *our* frames
would have us verifying a checksum that zstd's default frames do not carry, which is about a
sixth of our decode time and none of theirs; that mistake was in the first version of this
benchmark.

| | ours | zstd -3 | gzip -6 |
|---|---:|---:|---:|
| compress, source | 15-19 MB/s | 210-300 MB/s | 57-67 MB/s |
| compress, tor microdescs | 33 MB/s | 798 MB/s | 70 MB/s |
| decompress, source | 152-166 MB/s | 689-1152 MB/s | 481-619 MB/s |
| decompress, tor microdescs | 253 MB/s | 2739 MB/s | 379 MB/s |

**Compressing, 13-26x slower than `zstd -3` and 3-5x slower than `gzip -6`. Decompressing, 4.5-11x
slower than zstd and 2-3x slower than gzip.** This is not like for like — zstd is native code with
two decades of tuning — but the gap is larger than that alone explains, and both halves have a
known cause.

*Compressing*, the time is in the match search, and it is doing useful work: cutting the chain
from 32 candidates to 4 makes source 64% faster and 12% bigger, and makes the Tor
microdescriptors both **slower and 2x bigger**, because short matches mean more sequences to
code. The other candidate is cheaper than it looks — building both codings per block and keeping
the smaller costs 15% of the time and buys 22-29% of ratio, which is the best trade in the
package.

*Decompressing*, the bitstream reader used to take **one bit at a time**, which was the single
biggest lever: a Huffman symbol needs an eleven-bit lookahead, so every literal cost eleven loop
iterations. Caching a window of bits in the reader was worth **+44%** — 105 to 152 MB/s on
source, 168 to 253 on the Tor microdescriptors.

Two further attempts were worth nothing and are recorded because the reasoning behind them was
wrong rather than merely unlucky:

- replacing `push(get(i))` per matched byte with one bulk call moved decoding by 4%. The engine
  was already inlining those calls;
- hoisting `Buf`'s fields out of its copy loops moved nothing at all. Measured before and after:
  885 MB/s against 894.

What the same measurements did establish is where the copy floor was: a byte-at-a-time copy in wac
ran at about 900 MB/s, because every byte paid two bounds checks. That was `wac` issue 0056, filed
from this package while looking at the compressor's accumulation buffer — and it has since been
fixed. `copyFrom` is a single wasm instruction, and `Buf.pushBytes` went from **885 to 2906 MB/s**
once it used one.

One subtlety made that less mechanical than it looks. `copyFrom` moves like `memmove`, which is
right when the ranges are apart and **wrong when they overlap**: a match of five bytes from one
back is how every LZ77 descendant spells a run, and it wants the bytes the copy is writing, not
the ones that were there before. So `Buf.pushRepeat` and the gzip window's `pushMatch` use the
instruction only when the source ends before the destination begins, and keep the loop for the
overlapping case they exist to serve.

XXH64 remains at 782 MB/s, for a related reason that no bulk instruction fixes: it reads eight
bytes with eight array reads and shifts, because wac has no unaligned load.

### The whole of the Tor bootstrap data

The corpus takes 2 MB slices to stay quick. The full files, which is where an encoder bug was
found that nothing smaller reached:

| entry | raw | ours | ms | MB/s | gzip -6 | zstd -3 | zstd -19 |
|---|---:|---:|---:|---:|---:|---:|---:|
| microdescs | 38,213,719 | **4,039,712** | 1,139 | 33.6 | 16,899,870 | 3,247,759 | 2,317,304 |
| consensus-microdesc | 3,422,706 | 902,519 | 250 | 13.7 | 849,782 | 818,482 | 728,222 |
| authority-certs | 20,442 | 13,140 | 1 | 18.3 | 12,928 | 12,893 | 12,897 |

38 MB of microdescriptors compresses to **a quarter of what gzip manages** and within 24% of
`zstd -3`, at 34 MB/s. The bug: a literals section of 16 KiB or more uses the widest header form,
five bytes with neither size on a byte boundary — and ours wrote six bytes with the fields in the
wrong places. Every test passed, because no sample under 2 MB ever produced a literals section
that large. `test/encode.test.ts` now builds inputs that land in each of the three widths.

The Tor microdescriptors are the sample worth staring at: **a third of gzip's size**, because
gzip's window is 32 KiB and the file repeats itself at far greater range than that, while ours
reaches back a megabyte. It is also, at 1.30x, the furthest we are from `zstd -3`.

Note what changed when the corpus did. The samples this package started with were repeated
phrases, and against those `zstd -3` looked 2.4x better on json — a property of the generator, not
of the compressor. **Two of the three conclusions drawn from the synthetic corpus were wrong**,
which is why `bench/corpus.ts` now builds from files that are actually on the machine.

### Where the bytes go, and what fitted tables were worth

Worth measuring rather than assuming — the obvious answer was wrong twice. On 925 KB of this
repo's own source, before fitted tables were added:

| | size | ratio |
|---|---:|---:|
| ours, predefined tables only | 347,805 | 2.72x |
| zstd -1 | 309,243 | 3.06x |
| gzip -6 | 268,471 | 3.53x |
| zstd -3 | 272,498 | 3.48x |
| **the matches we already find, coded ideally** | **~269,800** | **3.51x** |

**The matches were not the problem.** Coding the sequences we already produced at the entropy of
their own distributions was predicted to reach zstd -3 on this data — and adding fitted tables
landed at **270,049**, within 0.1% of that estimate. Per sequence, before:

| | bits per sequence |
|---|---:|
| offset extra bits | 11.0 |
| the three codes, at the entropy of their actual distributions | 8.1 |
| length extra bits | 0.0 |

and literals are **10 KB of a 925 KB input** — entropy-coding them would save around 4 KB of 348 KB.

1. ~~**Transmitted FSE tables**~~ — done. Both codings are built per block and the shorter kept,
   because neither always wins: a block with few sequences cannot recover the cost of describing
   three tables, and small blocks do still choose the predefined ones.

What is left, in order:

1. ~~**Huffman literals**~~ — done, and worth what the measurement said: the estimate was 24,308
   bytes on the Tor microdescriptors and it came out at 23,134. Across the corpus it took us from
   1.07x of `zstd -3` to 1.04x. A section of one repeated byte becomes RLE instead, and a
   section whose coding would not pay stays raw.

   **With one limitation, and it is why the binaries did not move.** A tree description written
   directly carries at most 128 weights, because its header byte holds `127 + the count`. Wider
   alphabets need the FSE-coded form, which needs the two-state interleaved FSE *encoder* this
   package does not have — the one shape whose termination does not invert cleanly, and which
   was skipped on the grounds that nothing needed it. Something does now. Literals containing a
   byte above 128 therefore stay raw, which covers text, base64 and json but not machine code.
3. **Better matching**, which is what separates us from `zstd -19` — 18% across the corpus — and
   is most of the remaining gap on the Tor consensus, where offsets alone cost 296 KB of a
   586 KB output at an average match of only 13 bytes. `zstd -19` reaches 4.25x on the
   same input against `-3`'s 3.48x, purely by parsing better. Our average match is 8.7 bytes from
   a greedy search 32 candidates deep; lazy matching and a deeper chain are what raise that.
2. **Repeat offsets** — deep but narrow. Across the whole corpus exactly one sample wants them:
   the native executable, where **63% of offsets would hit a repeat slot** and the offset budget
   would fall from 58 KB to 32 KB. Everywhere else it is 0-8%, including both Tor samples at
   0-1%. Worth having, but it is one sample rather than a general win — which is the opposite of
   what the synthetic log lines suggested. Note the interaction: a greedy matcher takes every
   three-byte match it finds, which *minimises* literals. A better parser skips bad matches and
   emits more of them, so this grows as (3) lands.

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
| `src/encode.wac` | the compressor: matching, sequences, blocks, frames |
| `test/reference.ts` | Node's zstd, both directions, in this process — `node:zlib` works under Deno |
| `test/frame.test.ts` | against encoder output, and hand-built frames Node validates |
| `test/fse.test.ts` | the three checks above |
| `test/huffman.test.ts` | literals as a subsequence, and the table build |
| `test/decode.test.ts` | whole frames against Node, and which codings were reached |
| `test/xxh64.test.ts` | the published vectors |
| `test/fseenc.test.ts` | encode, then decode with the decoder that reads real frames |
| `test/encode.test.ts` | our frames, decompressed by zstd itself |
| `test/frames.ts` | walking a real frame to find its FSE-coded pieces |
| `test/writer.ts` | the description writer, for round-tripping |
| `cov.ts` | `deno task coverage:zstd` — **91.8%**, and the number is in the tool rather than here |


## Coverage, and why the number moved

This said 100% and the tool said 91.2%. The gap was **an hour old**: `unzstdStream` and the streaming
`Xxh64` arrived with 0088 and `cov.ts` did not learn about them, so the newest code in the package had no
measurement at all — `stream.wac` was not even a row in the report.

`cov.ts` exercises both now — frames cut at five chunk sizes, truncated and malformed input, a reader that
fails rather than ending, and the hash at every chunk size across a stripe boundary — which puts the
package at **91.8%**, with `stream.wac` itself at 57%. What is left there is mostly the refusal paths
inside a frame: a reserved block type, a dictionary id, a content-size mismatch. They are worth reaching
and are not reached yet.

The number is written here because it is useful, and it will rot again. It rotted within the hour last
time. **Run the task** — that is the only version of this that cannot be wrong.
