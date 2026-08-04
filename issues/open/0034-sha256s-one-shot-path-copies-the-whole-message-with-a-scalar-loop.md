# 0034 — `sha256`'s one-shot path copies the whole message with a scalar loop

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-c
- **Date:** 2026-08-04
- **Kind:** performance
- **Symptom:** wrong answer

`packages/crypto/src/sha256.wac:56`:

```wac
export u8[] sha256(u8[] msg) {
  i32 blocks = (len + 9 + 63) / 64;
  i32 total  = blocks * 64;

  u8[] m = u8[total]();
  for (i32 i = 0; i < len; i++) { m[i] = msg[i]; }   // <- this
  m[len] = 0x80;
```

Two costs, one avoidable and one worse than avoidable:

1. **The copy is element-wise** where `copyFrom` (i.e. `array.copy`) exists. wac issue 0056 measured
   the hand loop at about **790 MB/s per megabyte**. For the 36MB benchmark measured at 270ms total,
   that is roughly **45ms, about 17% of runtime**, recoverable in one line:

   ```wac
   m.copyFrom(msg, 0, 0, len);
   ```

2. **It allocates a full padded duplicate of the message.** A 36MB hash allocates 36MB and copies it
   before hashing a byte. The package already has an incremental API — `update`/`finish` — that never
   materialises the whole thing, so the one-shot path could stream over the input in 64-byte blocks
   and allocate nothing but the tail block.

Fixing (1) is a line. Fixing (2) is the better fix and makes (1) moot.

## Sweep the rest

This is not the only one. `copyFrom` and `fill` landed in wac 0056 and most callers predate them, so
a sweep for `for (…) { dst[i] = src[i]; }` across all packages is worth doing in the same pass —
`bytes`, `gzip`, `zstd` and `tls` all move byte ranges.

## Why it is filed rather than fixed

`packages/crypto` is shared and both other agents have touched it recently — agent-a added the
incremental SHA-512, agent-b works in `bls` above it. The change is small but it is in a hot path
several people depend on, and (2) changes an exported function's allocation behaviour.

## Why it matters beyond the 17%

This is one of four items that must land **before** anyone measures the SIMD proposals (wac 0070,
0071), because every figure in them is quoted against a baseline that should already contain these.
The others: wac 0069 (rotate, `clz`, `ctz`, `popcnt`), the sweep above, and issue 0035 in this repo.
