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
];
