// `hybrid.wac`'s length guards, driven one call at a time because a trap ends the module.
//
// See `test/wac/hybrid_traps.wac` for why the over-long cases carry the weight: a short input traps
// anyway when the copy loop reads past its end, so a fixture of short inputs leaves every guard deletable.
// An over-long share is copied happily and silently truncated, which is a key exchange completing over a
// secret derived from part of what arrived.

import { wacBind } from "../../../harness/wacBind.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

const m = await wacBind("packages/tls/test/wac/hybrid_traps.wac") as Record<string, () => number>;

function assertTraps(name: string): void {
  try {
    m[name]();
  } catch (e) {
    if (!(e instanceof WebAssembly.RuntimeError) && !/unreachable|out of bounds/i.test((e as Error).message)) {
      throw new Error(`${name} threw something unexpected: ${(e as Error).message}`);
    }
    return;
  }
  throw new Error(`${name} returned instead of trapping`);
}

Deno.test("an offer refuses a seed or a scalar that is not its length", () => {
  for (const name of ["offerSeedShort", "offerSeedLong", "offerScalarShort", "offerScalarLong"]) {
    assertTraps(name);
  }
});

Deno.test("a server refuses a client share, randomness or scalar of the wrong length", () => {
  // `acceptShareLong` is the one that matters most: 1300 bytes where 1216 belong. Without the check the
  // first 1184 become the ML-KEM key and the next 32 the X25519 point, and the answer is a well-formed
  // 1120-byte share computed from a prefix of what the peer sent.
  for (const name of ["acceptShareShort", "acceptShareLong", "acceptRandomShort", "acceptRandomLong",
                      "acceptScalarLong"]) {
    assertTraps(name);
  }
});

Deno.test("a client refuses to finish from the wrong lengths", () => {
  for (const name of ["finishOfferLong", "finishServerShareShort", "finishServerShareLong",
                      "finishScalarLong"]) {
    assertTraps(name);
  }
});

Deno.test("and a real exchange still produces a shared secret", () => {
  // The control. Every case above would pass if the module trapped on everything, and then this file
  // would be checking nothing at all.
  assertEquals(m.ordinary(), 64, "the hybrid shared secret is 64 bytes");
});
