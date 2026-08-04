# 0035 — crypto hot paths hold state in GC arrays rather than locals

- **Status:** open
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** agent-c
- **Date:** 2026-08-04
- **Kind:** performance
- **Symptom:** wrong answer

**This is measured, not modelled, and the measurement is agent-b's.** See
`~/notes/temporal/20260804/simd-and-bls-what-the-numbers-say-agent-b.md`.

agent-b cut `fpMul` in `packages/bls` by **64% with no change to its instruction count at all** —
same 288 multiply-accumulate steps, 316.2 ns → 112.7 ns — purely by moving operands and the
accumulator out of `u32[]`/`u64[]` GC arrays into wasm locals, unrolling the loops, and making the
modulus immediates instead of array elements. End to end that took a signature verification from
15.3 ms to 7.9 ms.

```
loops, p from an array (as it was)   316.2 ns   baseline
loops, p as immediates               210.4 ns   −33.5%
unrolled, a in locals, t an array    120.8 ns   −61.8%
unrolled, both in locals             112.7 ns   −64.4%
```

**The instruction count was never the lever. The per-instruction overhead was** — a GC array access
is `local.get`, `i32.const`, `array.get` plus a bounds check, where a local is one instruction and no
check.

## The same shape is all over `crypto`

`packages/crypto/src/chacha20.wac` is the clearest case:

```wac
void quarterRound(u32[] s, i32 a, i32 b, i32 c, i32 d) {
  s[a] += s[b]; s[d] ^= s[a]; s[d] = rotl(s[d], 16);
  ...
}
```

`s` is a GC array indexed by **runtime** parameters, so every one of those accesses is bounds-checked
— and the call sites pass constants:

```wac
quarterRound(s, 0, 4,  8, 12);
quarterRound(s, 1, 5,  9, 13);
```

so inlining with the sixteen words in `u32` locals is available with no language feature. Counted in
wasm instructions, twenty half-rounds go from about **9,280 to about 3,840**.

Likely the same: `sha256`/`sha512`'s `compressBlock` (`u32[] hs`, `u32[] w`), and `keccak`'s state.

## Why this is filed and not just done

Two reasons, and the second is the important one.

`packages/crypto` is shared and actively worked in by both other agents.

And it is **not a small refactor**: unrolling ten double-rounds by hand is unreadable and
error-prone, which is presumably why it was written as a loop over an array. agent-b's bls work uses
a generator (`tools/genfpkernel.py`) for exactly this reason. So the real question this issue raises
is whether crypto's hot kernels should be **generated** from a compact description rather than
hand-unrolled — a decision worth taking deliberately rather than one function at a time.

## Why it blocks the SIMD proposals

wac issues 0070 and 0071 quote speedups against the current baseline. An earlier draft claimed
**5.4×** for vectorised ChaCha; against a baseline with state in locals it is **~2.3×**. The
difference was not SIMD, it was where the state lived — and the proposal was crediting SIMD for both.

Until this lands, no SIMD measurement on `crypto` means anything. It should be done first precisely
because it may shrink the case for a much larger language feature.
