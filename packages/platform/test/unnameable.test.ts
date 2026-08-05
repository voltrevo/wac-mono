// A file this runtime cannot name, and what the world says about it.
//
// wac-mono 0065's second half. A filename that is not valid UTF-8 — `bad-\xff-name` — is an ordinary file
// on this filesystem, and `Deno.readDir` hands it back as `bad-\ufffd-name`: the invalid byte replaced by
// U+FFFD, lossily, with no byte-oriented alternative anywhere in that API. `Deno.stat` of the name it just
// gave you then fails `NotFound`.
//
// So the file is genuinely unnameable from Deno, and 0065's first half — making arguments bytes rather than
// text — cannot fix it, because the loss is inside the host's own API rather than at our bridge. What *can*
// be fixed is the sentence: "no such file or directory" for a file the caller has just listed blames them
// for the runtime's limit. `FAULT_NOT_REPRESENTABLE` is the category.
//
// Here: that the refinement fires on the right paths and only those. The user-visible half — what a shell
// prints — is `packages/sh/test/unnameable.test.ts`, because that is where a person meets it.

import {
  faultOfPath,
  FAULT_DENIED,
  FAULT_NONE,
  FAULT_NOT_FOUND,
  FAULT_NOT_REPRESENTABLE,
  pathFailure,
  phraseOf,
  STAT_BYTES,
  STAT_FAULT,
  statFault,
} from "../host/faults.ts";

/** Local, because this repo has no third-party dependencies. */
function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    throw new Error(
      `assertEquals failed${msg === undefined ? "" : ` — ${msg}`}\n` +
        `  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

const notFound = () => new Deno.errors.NotFound("no such file or directory");
const lossy = "/tmp/x/bad-\ufffd-name";

Deno.test("a NotFound for a lossy name is a naming failure, not an absence", () => {
  assertEquals(faultOfPath(notFound(), lossy), FAULT_NOT_REPRESENTABLE);
  const refined = pathFailure(notFound(), lossy) as Error & { fault?: number };
  assertEquals(refined.fault, FAULT_NOT_REPRESENTABLE);
  assertEquals(refined.message.includes("not representable"), true, refined.message);
});

Deno.test("an ordinary NotFound stays absent, and other faults are untouched", () => {
  // The refinement must not swallow absence: `rm -f` and every "does it exist" check depend on it.
  assertEquals(faultOfPath(notFound(), "/tmp/x/missing"), FAULT_NOT_FOUND);
  assertEquals(pathFailure(notFound(), "/tmp/x/missing") instanceof Deno.errors.NotFound, true);

  // A permission failure on a lossy name is still a permission failure — the name was expressible
  // enough to be refused, so claiming otherwise would be a second wrong answer.
  const denied = new Deno.errors.PermissionDenied("permission denied");
  assertEquals(faultOfPath(denied, lossy), FAULT_DENIED);
  assertEquals(pathFailure(denied, lossy), denied);
});

Deno.test("the category has a phrase, since a caller with no words of its own prints it", () => {
  assertEquals(phraseOf(FAULT_NOT_REPRESENTABLE), "the name is not representable on this host");
  assertEquals(phraseOf(FAULT_NOT_FOUND) === phraseOf(FAULT_NOT_REPRESENTABLE), false);
});

Deno.test("`stat` reports a fault only where the answer is unknowable", () => {
  // The narrowness is the design. `Stat` gained a fault field so that "this name cannot be expressed" and
  // "no read capability" stop arriving as `exists = false` — but absence itself must stay an answer, or
  // every `test -e`, `rm -f` and "does it exist" check in the repo starts reporting failures it is
  // written to ignore.
  assertEquals(statFault(notFound(), lossy), FAULT_NOT_REPRESENTABLE);
  assertEquals(statFault(notFound(), "/tmp/x/missing"), FAULT_NONE);
  assertEquals(statFault(new Deno.errors.PermissionDenied("denied"), "/tmp/x/f"), FAULT_DENIED);

  // `ENOTDIR` is the case that decides the shape: bash says `test -e f/g` is *false* where `f` is a file,
  // not an error, so a fault there would make every shell of ours disagree with the oracle.
  const notDir = Object.assign(new Error("Not a directory (os error 20)"), { code: "ENOTDIR" });
  assertEquals(statFault(notDir, "/tmp/x/file/inside"), FAULT_NONE);
});

Deno.test("the stat wire layout is one definition, since three hosts write it", () => {
  // Deno, Node and the browser all answer OP.STAT, and `provider.ts` reads what they wrote. A field
  // appended in two hosts out of three is a silent disagreement about a wire format — which is exactly how
  // `spawn`'s argv was wrong for a week.
  assertEquals(STAT_FAULT, 20, "the fault byte moved without the hosts being told");
  assertEquals(STAT_BYTES, STAT_FAULT + 1, "the reply is not wide enough to hold the fault");
});
