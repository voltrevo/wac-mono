// Walking a parsed tree from TypeScript.
//
// New, and the reason `json.wac` no longer has a status byte in it: a `JsonValue` crosses the
// boundary as a class with a `tag` to switch on, and the containers arrive with their methods, so
// a JSON document is walkable from the host without being re-serialized first.
//
// Worth its own test because it is the interface a caller now actually uses. The rest of this
// package's tests go through `canonicalize`, which compares bytes and would not notice a tree that
// serialized correctly but was shaped wrongly — a number stored as a string, say, or a member
// order that only survives because the serializer re-derives it.

import { wacBind } from "../../../harness/wacBind.ts";
import { assertEquals } from "./util.ts";

const mod = await wacBind("packages/json/src/json.wac") as unknown as {
  parse(src: Uint8Array): JsonRef | null;
  stringify(value: JsonRef): Uint8Array;
};

/** The generated class, as much of it as these tests touch. */
type JsonRef = {
  readonly tag: "Null" | "Bool" | "Number" | "Str" | "Array" | "Object";
  readonly Bool_value: boolean;
  readonly Number_value: number;
  readonly Number_raw: Uint8Array;
  readonly Str_bytes: Uint8Array;
  readonly Array_items: { len(): number; get(i: number): JsonRef };
  readonly Object_members: { len(): number; at(i: number): { key: Uint8Array; value: JsonRef; keyStr(): string } };
};

const enc = new TextEncoder();
const dec = new TextDecoder();
const parse = (s: string): JsonRef | null => mod.parse(enc.encode(s));

Deno.test("every kind arrives with the right tag", () => {
  const cases: Array<[string, string]> = [
    ["null", "Null"],
    ["true", "Bool"],
    ["1", "Number"],
    ['"x"', "Str"],
    ["[]", "Array"],
    ["{}", "Object"],
  ];
  for (const [src, tag] of cases) {
    const v = parse(src);
    if (v === null) throw new Error(`${src} did not parse`);
    assertEquals(v.tag, tag, src);
  }
});

Deno.test("a document that is not JSON parses as null", () => {
  for (const src of ["", "{", "[1,]", "tru", '{"a"}', "1 2"]) {
    if (parse(src) !== null) throw new Error(`${JSON.stringify(src)} should not have parsed`);
  }
});

Deno.test("scalars carry their values", () => {
  assertEquals(parse("true")!.Bool_value, true);
  assertEquals(parse("false")!.Bool_value, false);
  assertEquals(parse("1.5")!.Number_value, 1.5);
  assertEquals(parse("-0")!.Number_value, -0);
  assertEquals(dec.decode(parse('"héllo"')!.Str_bytes), "héllo");
  // The source span, which is what makes a round trip byte-exact. A tree walker can see it too.
  assertEquals(dec.decode(parse("1e2")!.Number_raw), "1e2");
  assertEquals(parse("1e2")!.Number_value, 100);
});

Deno.test("containers are walkable, in order and with duplicates", () => {
  const arr = parse("[1,true,null,[2]]")!;
  assertEquals(arr.Array_items.len(), 4);
  assertEquals(arr.Array_items.get(0).Number_value, 1);
  assertEquals(arr.Array_items.get(1).Bool_value, true);
  assertEquals(arr.Array_items.get(2).tag, "Null");
  assertEquals(arr.Array_items.get(3).Array_items.get(0).Number_value, 2);

  const obj = parse('{"b":1,"a":2,"b":3}')!;
  assertEquals(obj.Object_members.len(), 3, "a duplicate key is kept");
  assertEquals(obj.Object_members.at(0).keyStr(), "b", "source order, not sorted");
  assertEquals(obj.Object_members.at(1).keyStr(), "a");
  assertEquals(obj.Object_members.at(2).keyStr(), "b");
  assertEquals(obj.Object_members.at(0).value.Number_value, 1);
  assertEquals(obj.Object_members.at(2).value.Number_value, 3);
});

Deno.test("reading the wrong variant throws rather than lying", () => {
  // The protection `match` gives inside wac, arriving as an exception rather than a wrong answer.
  const n = parse("1")!;
  let threw = false;
  try {
    n.Str_bytes;
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("reading Str_bytes off a Number did not throw");
});

Deno.test("a tree handed back serializes to what it came from", () => {
  // `stringify` is the other direction, and takes the reference straight back — so this is a
  // round trip through the boundary, not through bytes.
  for (const src of ['{"b":1,"a":[1,2,{"c":true}],"n":1e2}', "[]", "{}", "null", '"x"', "-0"]) {
    const v = parse(src);
    if (v === null) throw new Error(`${src} did not parse`);
    assertEquals(dec.decode(mod.stringify(v)), src, src);
  }
});
