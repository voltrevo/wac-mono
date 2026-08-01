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

1. **FSE** (`fse.wac`) — the tANS entropy coder: read normalised counts, build the decoding table,
   and read the bitstream *backwards*. Everything below needs it, and it is the part with no
   analogue in `packages/gzip`, so it should be built and tested on its own before anything uses it.
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

## Layout

| path | what |
|---|---|
| `src/frame.wac` | frame headers, the block loop, raw and RLE blocks |
| `test/oracle.mjs` | Node's zstd, both directions, one subprocess per run |
| `test/frame.test.ts` | against encoder output, and hand-built frames Node validates |
| `cov.ts` | `deno task coverage:zstd` — 100% of branches |
