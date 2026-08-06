// Generated mutants that survive for a reason, with the reason.
//
// A curated mutation can carry its own `equivalent:` note. A generated one has nowhere
// to put it, so without this list every run either fails forever on a mutant nobody can
// kill, or gets its exit code ignored — and an ignored exit code is how a real survivor
// goes unnoticed.
//
// The bar is the same as for the curated field and as for gzip's UNREACHABLE list: an
// argument, not an assertion. An equivalent mutant is indistinguishable from a missing
// test until you show which one it is, and "I could not think of a test" is not showing.
// Where the argument is that some *other* check catches it, name the other check.
//
// Listing a mutant that later gets killed is also an error: the reason has stopped
// holding, and the entry has to go rather than sit there being wrong.

export type KnownSurvivor = { name: string; why: string };

export const KNOWN_SURVIVORS: KnownSurvivor[] = [
  {
    name: "guard/fmt/ftoa:230:23",
    why:
      "The carry-out-of-the-first-digit trap in `writeDecimal`, and the source above it carries the " +
      "proof that it cannot fire: if digit k+1 rounded up while `high` held, then r_k + mPlus_k > s, " +
      "which is the loop's own stopping condition at step k — so the loop would already have stopped " +
      "there, and only the first digit has no previous step to contradict. Measured as well as argued: " +
      "the branch was never taken by 60,000 random doubles nor by 60,000 neighbours of round decimals, " +
      "which is what prompted the proof. A test cannot kill this mutant because no input reaches the " +
      "line; the trap stays because an unreachable branch that stops beats one that silently does the " +
      "wrong thing if the proof is ever broken by a change. wac-mono 0005.",
  },
  {
    name: "extreme/bls/fp/isEvenRaw",
    why:
      "Binary extended GCD's halving test. Forcing it false removes every halving step, which " +
      "leaves plain subtractive Euclid — still correct, because the invariant x1·a ≡ u (mod p) is " +
      "preserved by the subtraction steps alone, and still fast, because Euclid's quotients are " +
      "small on average. Verified: the 32 inversion vectors pass in 51ms with it gutted. A genuine " +
      "equivalent mutant on correctness, differing only in worst-case speed, which no vector can " +
      "distinguish.",
  },
  {
    name: "guard/crypto/rsa:54:23",
    why:
      "toBytes' overflow guard, which fires when a value does not fit the length it is " +
      "being written into. Every caller takes that length from the modulus and passes a " +
      "value already reduced below it, so it always fits. Defensive against a future " +
      "caller that computes the length some other way, and recorded in " +
      "packages/crypto/cov.ts for the same reason.",
  },
  // ── crypto's remaining guards, after the ones that were real gaps were tested ──
  //
  // Nine survivors, each argued rather than tested. The distinction that matters is that
  // every one of these is *redundant* — the rejection still happens, by a different route
  // — rather than absent. The guards that turned out not to be redundant were tested
  // instead, and most of them were: every length check had an untested "too long" half,
  // and the coordinate range check turned out to be load-bearing.
  {
    name: "guard/crypto/fieldp:51:18",
    why:
      "pLimbs asked for a limb count that is neither eight nor twelve. Reachable only " +
      "by getting a field element of another size past fpFromBytes, whose own guard is " +
      "tested — so this and foldVector's copy and fpFromBytes' second check form a trio " +
      "where removing any one still leaves the value rejected by the next. Kept because " +
      "returning P-384's prime for a P-521 element would be arithmetic in a ring nobody " +
      "chose, and silence is the worst outcome for that.",
  },
  {
    name: "guard/crypto/fieldp:66:18",
    why: "foldVector's copy of the guard above. Same trio, same argument.",
  },
  {
    name: "guard/crypto/fieldp:321:28",
    why:
      "fpFromBytes rejecting a length that is a multiple of four but not a curve — 16 " +
      "bytes, say. Checked by removing it: the value goes on to pLimbs(4), which traps. " +
      "The guard is kept because it fails at the boundary with the length in hand rather " +
      "than several frames down.",
  },
  {
    name: "guard/crypto/weierstrass:163:25",
    why:
      "The y-coordinate's copy of the range check. Its x-coordinate twin is tested — a " +
      "point with x + p is accepted without it, because the arithmetic reduces and the " +
      "curve equation then passes — and the same is true here, but a witness needs a " +
      "curve point whose *y* is small enough that y + p still fits in the encoding. " +
      "Finding one means solving the curve equation for x given y, a cubic root modulo p " +
      "rather than a square root. The x case demonstrates the check is load-bearing; " +
      "this is the same line of code.",
  },
  {
    name: "guard/crypto/weierstrass:296:54",
    why:
      "curveEcdh rejecting a private scalar of zero or one at or above the group order. " +
      "Zero is caught two lines later, because 0*P is the identity and the identity has " +
      "no affine coordinates. A scalar at or above n is congruent to scalar mod n and " +
      "produces a correct shared secret, so nothing downstream can notice. Kept because " +
      "accepting it would mean two distinct private keys silently being one key.",
  },
  {
    name: "guard/crypto/weierstrass:298:32",
    why:
      "An ECDH result at infinity. These curves have prime order, so the only point of " +
      "small order is the identity itself, and curveDecode rejects anything not on the " +
      "curve — a validated peer point times a scalar in [1, n) cannot be the identity. " +
      "Kept because that argument depends on the validation above it staying correct.",
  },
  {
    name: "extreme/crypto/weierstrass/isZeroBE",
    why:
      "isZeroBE replaced with a constant false. Every caller has a second line of " +
      "defence: a zero private key multiplies to the identity and traps for want of " +
      "affine coordinates, and a zero r or s in a signature leads to a verification that " +
      "fails on the arithmetic instead. So the rejection still happens everywhere, later " +
      "and less clearly. Killing it would mean asserting on *which* error came back, " +
      "which is not something the API distinguishes.",
  },
  {
    name: "guard/crypto/mlkem:174:34",
    why:
      "The rejection-sampling loop running off the end of its SHAKE128 stream. The " +
      "squeeze asks for far more bytes than 256 coefficients need — about one candidate " +
      "in six is discarded, so 850 bytes suffice on average and the buffer is much " +
      "larger — and no seed has ever exhausted it. Unreachable rather than untested, and " +
      "the alternative to trapping is reading zeros and calling the result a public key.",
  },
  {
    name: "guard/crypto/keccak:137:34",
    why:
      "sponge's rate bounds. The only callers are sha3_256, sha3_512, shake128 and " +
      "shake256, which pass 136, 72, 168 and 136 — all constants in the same file. " +
      "Reachable only by a new caller, which is exactly who the guard is for.",
  },
  {
    name: "guard/crypto/ghash:49:31",
    why:
      "`data.len() % 16 != 0`. Redundant with the bounds check, not with nothing: for " +
      "any length that is not a whole number of blocks, the final iteration's " +
      "`beWord64(data, pos + 8)` reads past the end of the array and traps. Checked " +
      "against lengths 8, 17 and 24 with the guard removed — all still rejected. The " +
      "guard is kept because it makes the rejection say what is wrong rather than " +
      "surfacing as an out-of-range read, and because it stops being redundant the " +
      "moment the loop is rewritten to bulk-read. " +
      "Deleted once on 2026-08-02 because a run reported it killed, and restored when " +
      "that run turned out to be the one with the permissions bug — it had failed its " +
      "unmutated baseline, so every mutant scored as killed.",
  },
  // ── inflate's guards that a bounds check already enforces ───────────────────
  //
  // Ten of inflate's twelve `trap` guards survive deletion. That is not the same as
  // them being pointless: in each case the very next thing the code does is index an
  // array outside its bounds, and WasmGC traps on that unconditionally. The stream is
  // rejected either way, just with a worse reason and one step later.
  //
  // This was worth checking rather than assuming, because the identical-looking
  // argument was wrong four times out of five in crypto (see 9c937ce), and wrong once
  // here: `hlit > 286` looked equally redundant and was not — with it gone, an
  // otherwise-valid block with 287 literal codes decodes and returns. Each entry below
  // was confirmed by removing the guard and re-running a probe built to reach exactly
  // that check, not by reading the code.
  //
  // They stay because a named rejection beats an out-of-range read, and because the
  // redundancy is a property of the current code: any of them stops being redundant the
  // moment the array access it shields is reordered, widened or made bulk.
  {
    name: "guard/gzip/inflate:259:21",
    why:
      "`i == 0` before a repeat code. Without it `lengths[i - 1]` reads index -1, which " +
      "traps. Confirmed: a dynamic header whose first code-length symbol is 16 is still " +
      "rejected with the guard removed.",
  },
  {
    name: "guard/gzip/inflate:263:27",
    why:
      "`i >= total` inside symbol 16's repeat loop. Without it `lengths[i] = prev` writes " +
      "past the end of the array, which traps. Confirmed against a sequence that fills " +
      "255 of 258 entries and then repeats four times.",
  },
  {
    name: "guard/gzip/inflate:270:27",
    why: "`i >= total` inside symbol 17's zero run. Same as 263: the write past the end " +
      "traps. Confirmed against a run that starts at 256 of 258.",
  },
  {
    name: "guard/gzip/inflate:277:27",
    why: "`i >= total` inside symbol 18's zero run. Same as 263. Confirmed against a " +
      "138-entry run starting at 250 of 258.",
  },
  {
    name: "guard/gzip/inflate:302:23",
    why:
      "`li >= 29` for reserved literal/length symbols. Without it `t.lenBase[li]` indexes " +
      "a 29-entry table with 29 or 30 and traps. Confirmed with fixed-code symbol 286, " +
      "which is the only way to reach a li of 29 at all.",
  },
  {
    name: "guard/gzip/inflate:322:23",
    why:
      "`di >= 30` for reserved distance symbols. Unreachable rather than redundant: both " +
      "distance decoders are built with at most 30 symbols, so `decode` cannot return 30 " +
      "and a stream using distance code 30 or 31 dies inside `decode` for want of a " +
      "matching code. packages/gzip/cov.ts carries the same fact as an UNREACHABLE entry, " +
      "with the reason the check is kept. No test can kill this one.",
  },
  {
    name: "guard/gzip/inflate:324:26",
    why:
      "`d > out.len`, the distance bound. Without it the copy reads `out.get(out.len - d)` " +
      "with a negative index, which Buf.get and WasmGC both reject. The curated " +
      "inflate/distance-check-removed mutation records the same fact; this is the " +
      "generated mutant for the same line.",
  },
  {
    name: "guard/gzip/inflate:369:38",
    why:
      "`br.pos + 4 > data.len()` before reading a stored block's LEN and NLEN. Without it " +
      "`data[br.pos]` reads past the end and traps. Confirmed with a stored block header " +
      "and no bytes after it.",
  },
  {
    name: "guard/gzip/inflate:374:40",
    why:
      "`br.pos + len > data.len()` for a stored block's payload. Without it the copy loop " +
      "reads past the end and traps. Confirmed with LEN=255 and one byte of payload.",
  },
  {
    name: "guard/gzip/inflate:419:24",
    why:
      "`gz.len() < 18`, the minimum gzip member. Without it the header and trailer reads " +
      "overlap or run off the end and trap. Confirmed at 12 and 17 bytes with a " +
      "well-formed header, both still rejected.",
  },
  {
    name: "guard/gzip/inflate:441:26",
    why:
      "`pos >= gz.len()` after the optional header fields. Without it the deflate stream " +
      "starts past the end of the input and the bit reader traps. Confirmed with FNAME " +
      "set and a name that consumes the rest of the member.",
  },
  // ── gzip's tuning constants ─────────────────────────────────────────────────
  //
  // Six functions that return a threshold. `extreme` replaces each body with `return 0`,
  // which changes how the code goes about its work and not what it produces, so no
  // correctness test can kill them — and a correctness test is the only kind here.
  //
  // Worth separating the two reasons, because they are not equally comfortable. The
  // first two produce byte-identical output, verified rather than argued. The next three
  // change the compression ratio, which the suite deliberately does not pin — the same
  // category the curated list marks `ratioOnly`. The last is a memory bound, and the
  // mutation moves it in the safe direction, which is a limitation of the operator
  // rather than a property of the code.
  {
    name: "extreme/gzip/crc32/sliceThreshold",
    why:
      "The input length above which CRC-32 uses the slice-by-8 table instead of the " +
      "bitwise loop. Both compute the same CRC — crc32.test.ts checks them against each " +
      "other and against python — so the constant selects an implementation, not a " +
      "result. Verified: with it returning 0, gzip output over five input sizes is " +
      "byte-identical.",
  },
  {
    name: "extreme/gzip/inflate/rootBits",
    why:
      "The width of the Huffman fast-lookup table. A smaller table means more symbols " +
      "fall through to the canonical walk, which decodes them identically. Verified: " +
      "with it returning 0, round trips still hold and gzip output is byte-identical " +
      "over five input sizes.",
  },
  {
    name: "extreme/gzip/deflate/goodLength",
    why:
      "LZ77 search tuning — the match length beyond which the search narrows. Affects " +
      "the compression ratio, never correctness; every stream still round-trips and " +
      "still reads with the system gunzip. The suite allows ratio slack deliberately, " +
      "which is why the curated lz77/chain-limit mutation is marked ratioOnly and " +
      "survives for the same reason.",
  },
  {
    name: "extreme/gzip/deflate/niceLength",
    why: "LZ77 search tuning — the match length beyond which the search stops. Same as " +
      "goodLength: ratio, not correctness.",
  },
  {
    name: "extreme/gzip/gzip/smallInput",
    why: "The size below which gzipBest does not bother trying dynamic Huffman. Picks a " +
      "strategy; every strategy produces a valid stream. Ratio, not correctness.",
  },
  {
    name: "extreme/gzip/inflate/maxSizeHint",
    why:
      "The cap on how much of the gzip trailer's ISIZE is trusted for pre-allocation. " +
      "Returning 0 means never trusting it, which is the *conservative* direction — the " +
      "buffer grows normally and output is unchanged, so no test can object. The " +
      "dangerous direction is raising the cap, which `extreme` cannot express; the " +
      "`literal` operator on the 26 would. What the cap is actually for is now pinned " +
      "directly by inflate.test.ts, which checks that a member claiming 100 MiB, 1 GiB " +
      "or 4 GiB is rejected in under a second rather than attempting the allocation.",
  },
  // ── json's container bounds guards ──────────────────────────────────────────
  //
  // Both are the same argument, and it is the one every "redundant guard" claim has to make: name the
  // other check. Here there are two of them, and between them they cover the whole index range.
  {
    name: "guard/json/value:74:33",
    why:
      "`JsonArray.get`'s range trap. Removing it does not let a bad index through, because every " +
      "index it rejects is rejected again a line later: outside the backing array, `items[i]` is a " +
      "WasmGC bounds trap; between `n` and the allocation's length, the slot has never been written " +
      "and `items[i]!` traps on the null. `packages/json/test/bounds.test.ts` drives both routes — " +
      "`arrayPastEnd` is deliberately inside the allocation — and cannot distinguish them, because " +
      "what it can observe is that the call trapped, not which instruction did it. " +
      "The guard is kept rather than deleted because it is bounded by `n` and the fallback is bounded " +
      "by what happens to be in the slot: today those agree only because nothing ever un-writes one. " +
      "A `pop` that left the old value in place would make the guard the only thing still correct, " +
      "and that is exactly the change somebody adds without reading this accessor. wac-mono 0005.",
  },
  {
    name: "guard/bignum/big:354:19",
    why:
      "`divmod`'s division-by-zero trap. Removing it does not produce an answer: an empty divisor sends " +
      "Knuth's algorithm D to normalise `b.limbs[b.n - 1]`, which is `limbs[-1]` and a WasmGC bounds " +
      "trap. Measured rather than argued — with the guard deleted, all 42 of `packages/bignum`'s tests " +
      "pass, including `arith: division by zero traps` over 0, 1, -1 and 2^200. What no host can " +
      "distinguish is *which* instruction trapped, and pinning the trap's message would be a test of " +
      "the compiler rather than of this code. The guard stays because it fails at the top of the " +
      "function with the divisor in hand rather than several allocations deep. " +
      "Its sibling in `divSmall` is *not* here: that one was a real gap, since without it `0 /small 0` " +
      "returns zero instead of trapping, and `arith.test.ts` now covers the single-limb path. " +
      "wac-mono 0005.",
  },
  {
    name: "guard/json/value:153:37",
    why: "`JsonObject.at`'s copy of the guard above. Same two routes, same fixture pair " +
      "(`objectPastEnd`, `objectNegative`), same argument.",
  },
];
