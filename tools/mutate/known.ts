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
    name: "guard/crypto/ghash:49:31",
    why:
      "`data.len() % 16 != 0`. Redundant with the bounds check, not with nothing: for " +
      "any length that is not a whole number of blocks, the final iteration's " +
      "`beWord64(data, pos + 8)` reads past the end of the array and traps. Checked " +
      "against lengths 8, 17 and 24 with the guard removed — all still rejected. The " +
      "guard is kept because it makes the rejection say what is wrong rather than " +
      "surfacing as an out-of-range read, and because it stops being redundant the " +
      "moment the loop is rewritten to bulk-read.",
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
];
