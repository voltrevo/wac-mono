// Registers the wac-side tests for one directory request.
//
// The descriptor and the refused controls come from `data/hspublish.json`, where each control records
// the edit tor's own `hs_cache_store_as_dir` was given as well as its verdict — so the bytes replayed
// here are the bytes C tor saw, and the question is whether the same decision comes out.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

const D_DESCRIPTOR = 0;
const D_BLINDED = 1;
const D_CONTROL_COUNT = 2;
const D_CONTROL = 3;

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
  controls: { name: string; edit: Edit; result: { accepted: boolean } }[];
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

function control(i: number): string {
  const { edit } = v.controls[i];
  const d = generated.descriptor;
  if (edit.kind === "replace") return d.slice(0, edit.offset) + edit.byte + d.slice(edit.offset + 1);
  if (edit.kind === "truncate") return d.slice(0, edit.length);
  return d;
}

function ref(what: number, a: Uint8Array, _b: Uint8Array): Uint8Array {
  switch (what) {
    case D_DESCRIPTOR:
      return utf8(generated.descriptor);
    case D_BLINDED:
      return hex(v.blindedKey);
    case D_CONTROL_COUNT:
      return new Uint8Array([v.controls.length]);
    case D_CONTROL:
      return utf8(control(a[0]));
    default:
      throw new Error(`unknown vector field ${what}`);
  }
}

await wacTestRun("packages/tor/test/wac/dirstep_test.wac", "dirstep", [ref]);
