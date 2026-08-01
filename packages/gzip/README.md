# gzip

gzip (RFC 1952) and DEFLATE (RFC 1951) written in wac.

A package of [wac-mono](../../README.md) — see the root README for layout, the
import map, and how to run things. All commands run from the repo root.

## Status

Complete, both directions.

| Piece | State |
|---|---|
| CRC-32 | matches `zlib.crc32` |
| gzip container | `gunzip` accepts the output |
| Stored blocks (`BTYPE=00`) | done |
| Fixed Huffman + LZ77 (`BTYPE=01`) | done |
| Dynamic Huffman (`BTYPE=10`) | done, at or under `gzip -6` |
| Inflate | all three block types, plus raw deflate |
| Streaming inflate | `gunzipStream`, input and output both incremental |

### Streaming

`gunzipBytes` needs the whole member in memory and produces the whole payload at once.
`gunzipStream` does neither:

```wac
export i32 gunzipStream(fn[u8[]()] read, fn[bool(u8[])] write)
```

It pulls input through `read` and hands output to `write` as it is produced, holding only a
32 KiB window — the furthest a DEFLATE back-reference can reach — rather than the whole
output. What it retains is bounded by the flush threshold, currently 128 KiB, and not by the
size of the member: a 1 GiB file needs no more than a 1 KiB one.

Both entry points share `inflateInto`, so there is one copy of the format and the difference
between them is only where bytes come from and where they go. The trailer is what forces two
entry points rather than one: a buffer decode reads the CRC and length from the *last* eight
bytes before it starts, which is how it pre-sizes its output, while a stream has no last eight
bytes until it reaches them and so checksums as it goes. Same guarantees, opposite order — a
member that fails its CRC traps either way.

The signature is the one [`packages/stream`](../stream/README.md) drives, so a gzip file
becomes a `DecompressionStream` with no glue:

```ts
const out = file.readable.pipeThrough(
  wacTransformStream({ modulePath: "packages/gzip/src/inflate.wac", entry: "gunzipStream" }),
);
```

Compression does not stream yet. `packages/stream`'s bridge is generic, so a `deflateStream`
of the same shape would work the same way; what stops it is that DEFLATE's encoder chooses
its Huffman tables from a whole block, so the streaming unit is the block rather than the
chunk.

### Compression

Against `gzip -6`, smaller is better:

| sample | input | stored | fixed | dynamic | gzip -6 |
|---|---|---|---|---|---|
| prose ×30 | 3840 | 3863 | 163 | **146** | 147 |
| 8-byte pattern ×2000 | 16000 | 16023 | 137 | **65** | 66 |
| 5000 zeros | 5000 | 5023 | 54 | **39** | 40 |
| json-ish | 17181 | 17204 | 2838 | **1939** | 2004 |
| english words | 14999 | 15022 | 184 | **113** | 117 |
| incompressible | 20000 | 20023 | 18695 | 17882 | 17926 |

Dynamic lands at 0.97–1.00× of `gzip -6`. The small edge is structural, not
cleverness: this emits one block, so it pays one code header, while gzip splits
into several. On inputs large enough for splitting to pay off, gzip pulls ahead.

Two things are deliberately left on the table: matching is greedy rather than
lazy (zlib defers a match one byte to see if the next position does better,
worth a few percent), and code-length limiting is done by frequency scaling
rather than package-merge, which costs a fraction of a percent.

`gzipBest` tries all three block types and keeps the smallest, so output is
never larger than a stored block.

## Layout

```
src/            wac source — the actual implementation
  buf.wac         growable byte buffer
  crc32.wac       CRC-32 (bitwise, reflected 0xEDB88320)
  bitwriter.wac   LSB-first bit packing
  tables.wac      length/distance code tables (RFC 1951 3.2.5)
  huffman.wac     length-limited canonical Huffman construction
  deflate.wac     LZ77 + fixed and dynamic block encoding
  inflate.wac     decompressor and gzip reader
  gzip.wac        container, and the four entry points
test/           host-side tests, for anything needing an external oracle
  fuzz/           corpus generators and the python oracle
  wac/            tests written in wac, using the wactest package
```

The harness and tools live at the repo root and are shared with the other
packages.

## API

```ts
gzipStored(data)   // no compression, valid gzip
gzipFixed(data)    // LZ77 + the spec's fixed Huffman code
gzipDynamic(data)  // LZ77 + a code fitted to the data
gzipBest(data)     // smallest of the three
gunzipBytes(gz)    // read a gzip member
inflate(data)      // read a raw deflate stream
```

## Throughput

`deno task bench`. On 1 MiB, with python zlib alongside:

| | ours | python zlib |
|---|---:|---:|
| host/wasm boundary (identity) | 776 | — |
| stored blocks | 158 | — |
| dynamic, text | 28 | 50 |
| dynamic, already-compressible | 210 | 468 |
| inflate, text | 196 | 694 |
| inflate, incompressible | 114 | 2671 |

End to end on 4 MB of real TypeScript source: compress 22.3 MB/s at 24.0%,
decompress 148 MB/s — against zlib's 46.2 MB/s at 23.1%. So **~2.1x slower
compressing and ~3.0x decompressing**, for 0.9% less compression.

### How it got there

Every step was measured, and the first three guesses were wrong — worth recording
because the wrong guesses were the plausible ones.

| change | effect |
|---|---|
| Bulk array marshalling (in wac's bindgen) | boundary 35 -> 776 MB/s |
| Table-driven CRC-32 | inflate 34 -> 120 MB/s |
| Table-driven Huffman decode | ~4% |
| `gzipBest` stops compressing three times | 8.2 -> 21 MB/s, identical output |
| Match-search cutoffs (zlib's nice/good) | +19% compress, 0.9% larger output |
| Pre-sized inflate output from ISIZE | inflate +4% to +24% |
| Slice-by-8 CRC-32 | CRC 238 -> 636 MB/s, inflate +57% to +74% |

CRC-32 was the dominant cost twice over. Before any table it was 26 of the 30 ms
needed per MiB — more than LZ77 and Huffman coding combined — which is why every
operation used to sit at ~34 MB/s no matter how compressible the input was. The
byte-at-a-time table fixed most of that; slice-by-8 fixed the rest by removing the
loop-carried dependency, so eight independent lookups pipeline instead of
serialising on lookup latency.

Scaling is flat from 16K to 4 MB, so match search and hash inserts are linear.

`niceLength()` and `goodLength()` in `deflate.wac` are the ratio/speed dials. The
current values are zlib's level 6; the previous no-cutoff behaviour was closer to
level 9.

### What is left

- **Compression is greedy, not lazy.** zlib defers a match one byte to see if the
  next position does better. Worth a few percent of ratio, costs speed.
- **`Buf.push` is 1.3 ns/byte against a pre-sized array's 0.5.** WasmGC has
  `array.copy`, which wac does not expose, so a bulk copy is not writable in wac.
- **No SIMD.** Wasm SIMD only addresses linear memory, so a GC-array codec cannot
  vectorise match comparison at all. Native CRC also uses carry-less multiply,
  which wasm has no equivalent of — that gap is structural rather than fixable.

## Known limitations## Known limitations## Known limitations

- **Single-member only.** Concatenated gzip members are legal; this reads the
  first and then fails the trailer check. It traps rather than silently
  returning a prefix of the data.
- **One block per stream.** Fine up to a point, but a long input with shifting
  statistics would compress better split into blocks with their own codes.
- **Whole-buffer, not streaming.** Input and output are both fully in memory.

`u8[]` crosses the wasm boundary as a `Uint8Array` via wac's bindgen, so the
exports are plain `(data: Uint8Array) => Uint8Array` on the JS side.

## Testing

```sh
deno task test        # from the repo root
```

Two rules, both inherited from wac's CONTRIBUTING.md:

- **Expected values come from an external reference, never from eyeballing.**
  CRC-32 vectors are generated with Python's `zlib`; anything with a
  hand-computed constant says so and shows the derivation.
- **Interop is the real test, in both directions.** The compressor's output goes
  through the system `gunzip`; the decompressor's input comes from python's
  `gzip` and the `gzip` CLI across levels 0–9. Checking only that this code can
  read what it writes would let both halves share the same misreading of the
  format. Self-round-trip tests exist too, but as an addition, not the basis.
- **Tests must fail for the right reason.** A round-trip passes even if the
  compressor emits nothing but literals, so there are ratio assertions as well.
  The Huffman tests assert that an unlimited build of their input *would* exceed
  15 bits, so the length limiter is known to be running rather than incidentally
  satisfied.

### Differential fuzzing

`test/fuzz.test.ts` generates a corpus and runs it through python's zlib in both
directions. Random bytes alone would be a weak corpus — being incompressible,
they only ever exercise the literal path — so there are generators for runs,
periodic data, text, sparse data, small alphabets, exponentially skewed
frequencies (which force the 15-bit code-length limit), data placed at the 32 KiB
window edge, and mixtures. Sizes cluster on the awkward values: 0, 1, 2, 3, 258,
65535.

Corrupted streams are fuzzed too. The contract is that for *any* byte sequence
the decompressor either produces the right answer or fails — never a wrong answer
silently. Some corruptions are legitimately benign, since MTIME, XFL and the OS
byte are not covered by the CRC, so decoding is allowed but only to the original
bytes.

### Branch coverage

```sh
deno task coverage:gzip [--verbose]   # this package, including the hand-built streams
deno task coverage [--verbose]        # every package, from its wac-native tests
```

wac gained opt-in branch-coverage instrumentation
(`wacCompile(files, entry, { coverage: true })`), so the wac sources have a real number
rather than only mutation testing as a proxy. Current state:

| file | points | covered | % |
|---|---:|---:|---:|
| bitwriter.wac | 8 | 8 | 100.0 |
| crc32.wac | 16 | 16 | 100.0 |
| deflate.wac | 82 | 82 | 100.0 |
| gzip.wac | 21 | 21 | 100.0 |
| huffman.wac | 34 | 34 | 100.0 |
| inflate.wac | 92 | 91 | 98.9 |
| tables.wac | 7 | 7 | 100.0 |
| **all** | **260** | **259** | **99.6** |

Every reachable point is covered. The single exception is inflate's `di >= 30` check,
which cannot be reached: both distance decoders are built with at most 30 symbols, so a
stream using distance code 30 or 31 traps inside `Decoder.decode` for want of a matching
code instead. `cov.ts` lists it explicitly with that reason and fails if a point outside
that list goes uncovered — or if a listed one turns out to be reachable after all.

Getting there was mostly inflate's validation paths, and they needed streams built on
purpose. Random corruption does not reach them: a flipped bit in a Huffman-coded stream
breaks the symbol decode long before a code-length run overruns its table, so the stream
dies first. `test/streams.ts` assembles them bit by bit, and `cov.ts` drives the same
ones the tests assert on so the report describes a workload that is actually checked.

Two caveats on the number:

- It measures what `cov.ts` exercises, which mirrors the shapes the test suite drives
  rather than being the suite. `deno task coverage` gets closer for packages whose tests
  are wac-native, since there the tests *are* the exercise; gzip's are host-side, so it
  does not. Until counters are collected during the real test run, a branch reached with
  no assertion behind it is a gap no number here can show — which is why closing the last
  sixteen meant auditing each against the tests, and finding four already had them.
- An `if`/`else if` chain with no final `else` has no counter for falling past every
  arm, since points count arms entered.

### Mutation testing

```sh
deno task mutate                        # curated defects, all packages
deno task mutate --package gzip         # just this one
deno task mutate:operators              # ...plus generated guard and extreme mutants
```

Mutation testing answers what coverage is a proxy for, and answers it more directly:
break the implementation on purpose and check the tests notice. Coverage says a line
ran; a surviving mutant says nothing checked what the line *did*, which is the failure
a coverage number structurally cannot show. Each mutation is one deliberate defect — a
flipped comparison, an off-by-one on a boundary, a reversed bit order, a removed
validity check.

Mutants are compiled before any test runs, and one that emits byte-identical wasm is
discarded as provably equivalent rather than counted (Trivial Compiler Equivalence).
One that fails to compile is INVALID and excluded too — it tested nothing about the
tests, and scoring it as a kill is how a mutation score inflates itself. Runs are
scoped to the packages that import the mutated file, from the real import graph.

The suite includes a **no-op control mutation that must survive**. Without it, a
staged project failing to build for an unrelated reason would report every
mutation as killed and the run would look perfect while proving nothing — which
is exactly what happened on the first attempt, when the copied `deno.json` import
map no longer resolved. If the control is ever reported killed, disbelieve the
rest of the run.

Survivors are separated into three kinds, because "a mutation lived" on its own
does not say what to do about it:

- **ratio-only** — changes compression ratio, not correctness. Expected.
- **provably unobservable** — no behaviour differs, with the evidence recorded.
  Only marked after demonstrating it, never assumed.
- **genuine** — untested behaviour, and a failure.

Mutation testing found one real gap: removing inflate's "distance points before
the start of the output" check failed no test. Random corruption never reaches
that code, because a flipped bit breaks the Huffman symbol decode long before a
distance is ever validated. `test/inflate_adversarial.test.ts` now builds
malformed streams by hand to reach it, along with reserved symbols 286/287 and
30/31, stored blocks whose LEN runs off the end, truncation mid-symbol, and a
block with no end-of-block symbol.

Those distance-guard mutations still survive, and that turned out to be worth
understanding rather than fixing. Removing *both* source-level guards leaves the
behaviour unchanged: WasmGC's array bounds check traps on the negative index
regardless. The property is enforced three times over, so no mutation of the wac
source can be observable. In C the same edit would be a heap over-read; here the
compilation target makes it a trap. That is a real benefit of the target, and it
also means mutation scores on defensive checks should be read with it in mind.

## Notes on wac

Things worth knowing when writing wac, found while building this:

- `from` is a keyword (`import ... from`), so it cannot be a variable or
  parameter name. The resulting parse error can point tens of lines away.
- There are no top-level constants; use a small function instead.
- No trailing comma in a parameter list.
- `while (true) { ... return x; }` does not count as returning on all paths —
  the checker has no reachability analysis for it. Use a loop condition and a
  single return at the end.
- A struct cannot have a field and a method of the same name.
- `i8`/`i16` exist only as array element types — no locals, params, or fields.
  Reads zero-extend to `i32`, writes truncate.
- Hex literals are bit patterns: `0xEDB88320` is the `i32` `-306674912`.
