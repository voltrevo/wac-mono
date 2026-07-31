# wac-gzip

gzip (RFC 1952) and DEFLATE (RFC 1951) written in [wac](https://github.com/voltrevo/wac),
a C-family language for WebAssembly GC.

Deliberately kept out of the wac repo: wac is the language, this is a program
written in it. The only coupling is `deno.json`'s import map, which points at a
local wac checkout for the compiler:

```json
{ "imports": { "wac/": "../wac/atoms/wac/" } }
```

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
harness/        TypeScript glue for driving the compiler from tests
  wacFiles.ts     read an entry file and its transitive imports
  wacBind.ts      compile -> bindgen -> importable JS module
test/           Deno tests
  probe/          test-only wac entry points exposing internals
```

## API

```ts
gzipStored(data)   // no compression, valid gzip
gzipFixed(data)    // LZ77 + the spec's fixed Huffman code
gzipDynamic(data)  // LZ77 + a code fitted to the data
gzipBest(data)     // smallest of the three
gunzipBytes(gz)    // read a gzip member
inflate(data)      // read a raw deflate stream
```

## Known limitations

- **Single-member only.** Concatenated gzip members are legal; this reads the
  first and then fails the trailer check. It traps rather than silently
  returning a prefix of the data.
- **One block per stream.** Fine up to a point, but a long input with shifting
  statistics would compress better split into blocks with their own codes.
- **Whole-buffer, not streaming.** Input and output are both fully in memory.

`i8[]` crosses the wasm boundary as a `Uint8Array` via wac's bindgen, so the
exports are plain `(data: Uint8Array) => Uint8Array` on the JS side.

## Testing

```sh
deno task test
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

### Mutation testing

```sh
deno run -A tools/mutate.ts
```

`deno coverage` measures the TypeScript harness, not the compiled wasm, so there
is no branch-coverage number for the wac code. Mutation testing answers what
coverage is a proxy for, and answers it more directly: break the implementation
on purpose and check the tests notice. Each mutation is one deliberate defect — a
flipped comparison, an off-by-one on a boundary, a reversed bit order, a removed
validity check. A mutation that survives names a behaviour nothing checks.

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
