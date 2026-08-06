// Registers the wac-side HSDir-store tests.
//
// The controls come from `test/data/hspublish.json`, where each one records the *edit* as well as the
// outcome — an offset and a byte, or a truncation length. This file replays those edits so the wac
// checker sees exactly the bytes tor's `hs_cache_store_as_dir` saw, and the question narrows to
// whether the two reach the same verdict.
//
// Rebuilding the mutations here from a description ("flip a byte in the body") would be the failure
// mode this guards against: two ends agreeing about a control neither is actually running.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

const S_DESCRIPTOR = 0;
const S_BLINDED = 1;
const S_CONTROL_COUNT = 2;
const S_CONTROL = 3;

type Edit =
  | { kind: "replace"; offset: number; byte: string }
  | { kind: "truncate"; length: number }
  | { kind: "none" };

const v = JSON.parse(
  await Deno.readTextFile(new URL("data/hspublish.json", import.meta.url)),
) as {
  source: string;
  blindedKey: string;
  descriptorLength: number;
  controls: { name: string; edit: Edit; result: { accepted: boolean; stored: boolean } }[];
};

const generated = JSON.parse(
  await Deno.readTextFile(new URL("data/hsdesc_generated.json", import.meta.url)),
) as { descriptor: string; blindPublic: string };

const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const utf8 = (s: string) => new TextEncoder().encode(s);

if (!v.source.includes("hs_cache_store_as_dir")) {
  throw new Error(`the verdicts must be tor's — source is ${v.source}`);
}
if (v.descriptorLength !== generated.descriptor.length) {
  throw new Error("the generated descriptor has changed since the controls were captured");
}
for (const c of v.controls) {
  if (c.result.accepted) throw new Error(`the control ${c.name} was accepted, so it proves nothing`);
}

/** The exact bytes tor was handed for control `i`. */
function control(i: number): string {
  const { edit } = v.controls[i];
  const d = generated.descriptor;
  switch (edit.kind) {
    case "replace": {
      const out = d.slice(0, edit.offset) + edit.byte + d.slice(edit.offset + 1);
      if (out === d) throw new Error(`control ${i} edits nothing`);
      if (out.length !== d.length) throw new Error(`control ${i} changed the length`);
      return out;
    }
    case "truncate":
      return d.slice(0, edit.length);
    case "none":
      return d;
  }
}

// One control must be the unedited descriptor, or nothing distinguishes a bad document from a bad
// name — and that distinction is the whole reason publication needs an oracle.
if (!v.controls.some((c) => c.edit.kind === "none" && c.result.stored)) {
  throw new Error("no control is the real descriptor under a wrong name");
}

function ref(what: number, a: Uint8Array, _b: Uint8Array): Uint8Array {
  switch (what) {
    case S_DESCRIPTOR:
      return utf8(generated.descriptor);
    case S_BLINDED:
      return hex(v.blindedKey);
    case S_CONTROL_COUNT:
      return new Uint8Array([v.controls.length]);
    case S_CONTROL:
      return utf8(control(a[0]));
    default:
      throw new Error(`unknown vector field ${what}`);
  }
}

await wacTestRun("packages/tor/test/wac/hsstore_test.wac", "hsstore", [ref]);
