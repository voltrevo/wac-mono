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

| Piece | State |
|---|---|
| CRC-32 | done, matches `zlib.crc32` |
| gzip container | done, `gunzip` accepts the output |
| Stored blocks (`BTYPE=00`) | done |
| Inflate | not started |
| Fixed Huffman + LZ77 (`BTYPE=01`) | not started |
| Dynamic Huffman (`BTYPE=10`) | not started |

Stored blocks apply no compression — output is marginally larger than input.
Everything around the compressor is real, though, so the container is pinned
down before any Huffman work begins.

## Layout

```
src/          wac source — the actual implementation
  buf.wac       growable byte buffer
  crc32.wac     CRC-32 (bitwise, reflected 0xEDB88320)
  gzip.wac      container + stored blocks
harness/      TypeScript glue for driving the compiler from tests
  wacFiles.ts   read an entry file and its transitive imports
  wacBind.ts    compile -> bindgen -> importable JS module
test/         Deno tests
```

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
- **Interop is the real test.** The gzip tests pipe output through the system
  `gunzip`. A bad header, CRC, ISIZE, or block framing fails there rather than
  being argued about.

## Notes on wac

Things worth knowing when writing wac, found while building this:

- `from` is a keyword (`import ... from`), so it cannot be a parameter name.
- There are no top-level constants; use a small function instead.
- A struct cannot have a field and a method of the same name.
- `i8`/`i16` exist only as array element types — no locals, params, or fields.
  Reads zero-extend to `i32`, writes truncate.
- Hex literals are bit patterns: `0xEDB88320` is the `i32` `-306674912`.
