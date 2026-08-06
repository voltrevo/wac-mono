// The fault numbering exists twice, so this is where the two copies are made to agree.
//
// `host/faults.ts` classifies a host error into a category; `src/platform.wac` names the same categories
// for the program on the other side of the bridge. Neither can import the other — one is TypeScript running
// the world, the other is wac compiled to wasm — so the numbers are a shared constant with a copy on each
// side, and nothing checked that they matched. Insert a category in one file and every code above it shifts:
// a missing file starts reporting as denied, `rm -f` starts failing, and no test says a word, because each
// side is internally consistent.
//
// `packages/abi` had the same shape and the same hole (see `test/abi_wac.test.ts`), which is what suggested
// looking here.
//
// The second half is about **`Stat`**. `Change` and `FileResult` carry the host's own sentence, so a
// category with no phrase falls back to something readable. `Stat` carries no message — only the category —
// so a fault whose phrase is empty prints as nothing at all: `stat: cannot tell — ` with the line ending
// after the dash. Every category a `stat` can answer with therefore has to have words, and that is asserted
// rather than assumed.

import { wacBind } from "../../../harness/wacBind.ts";
import {
  FAULT_DENIED,
  FAULT_EXISTS,
  FAULT_NONE,
  FAULT_NOT_EMPTY,
  FAULT_NOT_FOUND,
  FAULT_NOT_GRANTED,
  FAULT_NOT_REPRESENTABLE,
  FAULT_OTHER,
  faultOf,
  phraseOf,
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

const probe = await wacBind("packages/platform/test/wac/faults_probe.wac") as Record<string, unknown>;
const codes = probe.codes as () => Int32Array;
const wordsOf = (fault: number) => new TextDecoder().decode((probe.words as (n: number) => Uint8Array)(fault));

/** The order `faults_probe.wac` writes them in. Both lists are spelled out so a rename cannot slide. */
const NAMED: [string, number][] = [
  ["FAULT_NONE", FAULT_NONE],
  ["FAULT_NOT_FOUND", FAULT_NOT_FOUND],
  ["FAULT_DENIED", FAULT_DENIED],
  ["FAULT_EXISTS", FAULT_EXISTS],
  ["FAULT_NOT_EMPTY", FAULT_NOT_EMPTY],
  ["FAULT_OTHER", FAULT_OTHER],
  ["FAULT_NOT_REPRESENTABLE", FAULT_NOT_REPRESENTABLE],
  ["FAULT_NOT_GRANTED", FAULT_NOT_GRANTED],
];

Deno.test("the two copies of the fault numbering agree", () => {
  const wac = [...codes()];
  assertEquals(wac.length, NAMED.length, "the probe and this file disagree about how many categories exist");
  for (let i = 0; i < NAMED.length; i++) {
    const [name, host] = NAMED[i];
    assertEquals(wac[i], host, `${name}: platform.wac says ${wac[i]}, host/faults.ts says ${host}`);
  }
  assertEquals(new Set(wac).size, wac.length, "two categories share a number");
});

Deno.test("every category a `stat` can answer with has words", () => {
  // `Stat` has no message field, so an empty phrase is an empty reason. These four are what a `stat` reply
  // can carry: `statFault` narrows a host error to two of them, the hosts answer `FAULT_NOT_GRANTED`
  // themselves when the world has no read capability, and `FAULT_NONE` means the answer is the answer.
  for (const fault of [FAULT_NOT_REPRESENTABLE, FAULT_DENIED, FAULT_NOT_GRANTED]) {
    assertEquals(wordsOf(fault).length > 0, true, `category ${fault} would print an empty reason`);
  }
  assertEquals(wordsOf(FAULT_NONE), "", "FAULT_NONE is not a fault and has nothing to say");
});

Deno.test("the categories with words say what the real tools say", () => {
  // GNU's own strings, because that is what the differential tests compare against — a shell of ours
  // printing "file not found" where `cat` prints "No such file or directory" fails those on the text.
  assertEquals(wordsOf(FAULT_NOT_FOUND), "No such file or directory");
  assertEquals(wordsOf(FAULT_DENIED), "Permission denied");
  assertEquals(wordsOf(FAULT_EXISTS), "File exists");
  assertEquals(wordsOf(FAULT_NOT_EMPTY), "Directory not empty");
  // These two have no GNU equivalent: a program the operating system starts was handed everything the
  // operating system has, and every name it can hold is one its filesystem can express.
  assertEquals(wordsOf(FAULT_NOT_GRANTED), "Not granted to this application");
  assertEquals(wordsOf(FAULT_NOT_REPRESENTABLE), "cannot be named on this host");
  // `FAULT_OTHER` deliberately has none: it means the host said something no category covers, and the
  // thing worth printing is that sentence. Both carriers of it — `Change` and `FileResult` — have one.
  assertEquals(wordsOf(FAULT_OTHER), "");
});

Deno.test("a grant that was never given is not classified as denial", () => {
  // The last line of `faultOf` matches on text, and it read `not granted` as `FAULT_DENIED` for as long as
  // `FAULT_NOT_GRANTED` had existed beside it — so the distinction the category was added for was
  // unobservable from anything that arrived as a message.
  assertEquals(faultOf(new Error("filesystem read not granted to this application")), FAULT_NOT_GRANTED);
  assertEquals(faultOf(new Error("network access is not granted")), FAULT_NOT_GRANTED);
  // And a real refusal by the operating system stays denial.
  assertEquals(faultOf(Object.assign(new Error("EACCES"), { code: "EACCES" })), FAULT_DENIED);
  assertEquals(faultOf(new Error("something else entirely")), FAULT_OTHER);
});

Deno.test("`statFault` still calls absence an answer", () => {
  // Guarding the narrowness this file's neighbour argues for: everything except the two unknowable cases
  // is `FAULT_NONE`, because `test -e f/g` where `f` is a file is *false* in bash rather than an error.
  assertEquals(statFault(Object.assign(new Error("ENOENT"), { code: "ENOENT" }), "/x"), FAULT_NONE);
  assertEquals(statFault(Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR" }), "/x/y"), FAULT_NONE);
  assertEquals(statFault(Object.assign(new Error("EACCES"), { code: "EACCES" }), "/x"), FAULT_DENIED);
});

Deno.test("the third copy of the phrase list covers the same categories", () => {
  // `phraseOf` is the host's own rendering — lower case, for embedding in a sentence a page shows — and it
  // is a separate list from `faultWords`. Two lists, so the thing to hold is not the wording but *which
  // categories have any*: a category with words on one side and none on the other is a reader who gets an
  // explanation from Deno and a blank from the browser.
  for (const [name, code] of NAMED) {
    assertEquals(
      phraseOf(code).length > 0,
      wordsOf(code).length > 0,
      `${name}: phraseOf says ${JSON.stringify(phraseOf(code))}, faultWords says ${JSON.stringify(wordsOf(code))}`,
    );
  }
});
