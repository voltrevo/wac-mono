// Differential walk of the parsed tree: build plain JavaScript data out of the wac-side
// `JsonValue` and compare against `JSON.parse`.
//
// Every other host test here observes bytes — the tree was unreachable from JavaScript, so
// what they check about it is really a check on its *re-serialization*, and a bug that
// cancelled itself out between parse and stringify would pass all of them. This one reads the
// tree directly, so parse is compared against the host on its own.

import { assertEquals } from "./util.ts";
import { wacBind } from "../../../harness/wacBind.ts";

/** The wrappers bindgen generates for `src/tree.wac`, as this test uses them. */
type Value = {
  tag: "Null" | "Bool" | "Number" | "Str" | "Array" | "Object";
  Bool_value: boolean;
  Number_value: number;
  Str_bytes: Uint8Array;
  Array_items: { len(): number; get(i: number): Value };
  Object_members: { len(): number; at(i: number): { keyStr(): string; value: Value } };
};

type TreeMod = {
  parse(src: string): Value | null;
  errorCodeOf(src: string): number;
};

let cached: TreeMod | null = null;
async function tree(): Promise<TreeMod> {
  if (cached === null) cached = await wacBind("packages/json/src/tree.wac") as unknown as TreeMod;
  return cached;
}

const dec = new TextDecoder();

/** The whole point of the test: a tree walk written the way a consumer would write it. */
function toJs(v: Value): unknown {
  switch (v.tag) {
    case "Null":   return null;
    case "Bool":   return v.Bool_value;
    case "Number": return v.Number_value;
    case "Str":    return dec.decode(v.Str_bytes);
    case "Array": {
      const items = v.Array_items;
      return Array.from({ length: items.len() }, (_, i) => toJs(items.get(i)));
    }
    case "Object": {
      const members = v.Object_members;
      const out: Record<string, unknown> = {};
      // Last wins, which is what JSON.parse does with a duplicate key. The tree keeps
      // both members — that is the parser being right, not a disagreement.
      for (let i = 0; i < members.len(); i++) out[members.at(i).keyStr()] = toJs(members.at(i).value);
      return out;
    }
  }
}

const CASES = [
  "null", "true", "false", "0", "-1", "42", "1.5", "-2.25", "1e3",
  '""', '"hello"', '"h\\u00e9llo \\ud83d\\ude00"', '"\\t\\n\\"\\\\"',
  "[]", "[1]", "[1,2,3]", "[[1],[2,[3]]]", "[null,true,false]",
  "{}", '{"a":1}', '{"a":1,"b":[2,3]}', '{"a":{"b":{"c":[]}}}',
  '{"deep":[1,[2,[3,[4]]]],"uni":"héllo 😀","neg":-0.5,"big":1e20}',
  '{"a":1,"a":2}',                       // duplicate keys: both kept, last wins on the way out
  '  \t{ "spaced" : [ 1 , 2 ] }\n',
];

Deno.test("the parsed tree walks to the same data JSON.parse produces", async () => {
  const m = await tree();
  for (const src of CASES) {
    const v = m.parse(src);
    if (v === null) throw new Error(`parse failed for ${src}`);
    assertEquals(
      JSON.stringify(toJs(v)),
      JSON.stringify(JSON.parse(src)),
      `tree walk differs for ${src}`,
    );
  }
});

Deno.test("an invalid document is null, with the error code alongside", async () => {
  const m = await tree();
  for (const src of ["", "{", "[1,", "nul", '{"a"}', "1 2", '"\\x"']) {
    assertEquals(m.parse(src), null, `expected a parse failure for ${JSON.stringify(src)}`);
    assertEquals(m.errorCodeOf(src) !== 0, true, `expected a nonzero code for ${JSON.stringify(src)}`);
  }
});

Deno.test("a duplicate key keeps both members in the tree", async () => {
  // The list *is* the JSON, and this is the thing a plain-object walk cannot show: the
  // tree has two members where `JSON.parse` has one key.
  const m = await tree();
  const v = m.parse('{"a":1,"a":2}');
  if (v === null || v.tag !== "Object") throw new Error("expected an object");
  assertEquals(v.Object_members.len(), 2, "both members survive");
  assertEquals(v.Object_members.at(0).keyStr(), "a");
  assertEquals(v.Object_members.at(1).value.Number_value, 2, "and the second is the later value");
});
