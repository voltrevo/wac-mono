# zstd

Zstandard (RFC 8878) in wac. **Decoder, and only the frame layer so far.**

A package of [wac-mono](../../README.md) — see the root README for layout, the import map, and
how to run things. All commands run from the repo root.

## Status

| Piece | State |
|---|---|
| Frame header, all field widths | done |
| Concatenated frames | done |
| Skippable frames | done |
| Raw blocks (`Block_Type=0`) | done |
| RLE blocks (`Block_Type=1`) | done |
| FSE (tANS) tables and bitstream | done |
| Compressed blocks (`Block_Type=2`) | **not implemented — traps** |
| Content checksum (XXH64) | field skipped, not verified |
| Dictionaries | not started |
| Compression | not started |

So `decompress` handles a real zstd file only when its encoder chose not to compress — which is
what happens for incompressible input, and nothing else. It is a foundation, not a codec.

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
2. **Huffman literals** — literals sections come raw, RLE, or Huffman-coded, with the Huffman
   weights themselves either FSE-compressed or written directly, in one stream or four.
3. **Sequences** — three interleaved FSE streams for literal lengths, match lengths and offsets,
   each of which may be predefined, RLE, freshly transmitted, or repeated from the last block.
4. **Sequence execution** — copy literals, then a match, with the three repeat-offset slots and
   their reordering rules. Easy to get subtly wrong and easy to test differentially.

Then XXH64 for the content checksum, which is independent of all of it.

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

## Layout

| path | what |
|---|---|
| `src/frame.wac` | frame headers, the block loop, raw and RLE blocks |
| `src/fse.wac` | FSE: table descriptions, table building, the backwards bitstream |
| `test/oracle.mjs` | Node's zstd, both directions, one subprocess per run |
| `test/frame.test.ts` | against encoder output, and hand-built frames Node validates |
| `test/fse.test.ts` | the three checks above |
| `test/frames.ts` | walking a real frame to find its FSE-coded pieces |
| `test/writer.ts` | the description writer, for round-tripping |
| `cov.ts` | `deno task coverage:zstd` — 100% of branches |
