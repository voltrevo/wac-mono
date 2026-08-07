// `record.wac`'s framing guards, from the host, because a trap ends the module.
//
// Eight came back from mutation testing untouched, on the layer whose entire input is a peer's bytes. See
// `test/wac/record_traps.wac` for what each one is; the shape they share is that none can be told from a
// valid record without checking, and one of them — a length past the plaintext limit — is a peer's
// instruction to allocate.

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

const m = await wacBind("packages/tls/test/wac/record_traps.wac") as Record<string, () => number>;

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

Deno.test("a record that does not frame is refused, whatever the peer says its length is", () => {
  for (const name of ["openTooShort", "openLengthMismatch", "openNoRoomForTag", "openTooLong"]) {
    assertTraps(name);
  }
});

Deno.test("a suite that was never negotiated is refused, sealing and opening", () => {
  for (const name of ["sealUnknownSuite", "openUnknownSuite"]) assertTraps(name);
});

Deno.test("a caller cannot ask for a record that cannot exist", () => {
  for (const name of ["sealNegativePadding", "sealTooMuchContent"]) assertTraps(name);
});

Deno.test("all padding and no content type is unexpected_message, not an empty record", () => {
  // Reachable from a peer: the padding is inside the encryption, so this is what a decryption that
  // succeeded can still hand back. RFC 8446 §5.4.
  assertTraps("contentAllPadding");
});

Deno.test("and a sealed record still opens", () => {
  assertEquals(m.ordinary(), 4, "four bytes sealed and opened");
});
