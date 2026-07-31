// Differential round-trip: parse + re-serialize in wac, compare against the
// host's JSON.stringify(JSON.parse(x)).
//
// The corpus keeps numbers in the form JS would print them, because wac emits
// a number's original source span verbatim (see stringify.wac). Number
// conversion is tested separately in number.test.ts, where the comparison is on
// the f64 value rather than its text.

import { assertEquals, canon, ERR } from "./util.ts";

const CASES = [
  // scalars
  "null",
  "true",
  "false",
  "0",
  "1",
  "-1",
  "42",
  "1.5",
  "-2.25",
  '""',
  '"hello"',

  // whitespace is not preserved
  "  null  ",
  "\t[\n1,\n2\n]\r\n",

  // arrays
  "[]",
  "[1]",
  "[1,2,3]",
  "[[[]]]",
  "[[1,[2,[3]]]]",
  "[null,true,false]",
  '["a","b"]',
  "[1,[2],{},{\"k\":[3]}]",

  // objects
  "{}",
  '{"a":1}',
  '{"a":1,"b":2}',
  '{"nested":{"deep":{"deeper":[1,2,3]}}}',
  '{"":0}',
  '{"a":[],"b":{}}',

  // string escapes that survive a round-trip unchanged
  '"a\\"b"',
  '"a\\\\b"',
  '"tab\\there"',
  '"nl\\nhere"',
  '"cr\\rhere"',
  '"bs\\bhere"',
  '"ff\\fhere"',
  '"\\u0000"',
  '"\\u001f"',

  // \/ is a legal escape that JSON.stringify does not re-escape
  '"a\\/b"',

  // multi-byte UTF-8 passes through
  '"café"',
  '"日本語"',
  '"😀"',
  '"\\u00e9"',
  '"\\u65e5"',
  '"\\ud83d\\ude00"',

  // a realistic document
  '{"name":"wac","tags":["lang","wasm"],"version":{"major":0,"minor":1},"stable":false,"notes":null}',
];

Deno.test("round-trip matches JSON.stringify(JSON.parse(x))", async () => {
  for (const src of CASES) {
    const got = await canon(src);
    assertEquals(got.err, ERR.NONE, `unexpected error ${got.err} for ${src}`);
    const want = JSON.stringify(JSON.parse(src));
    assertEquals(got.text, want, `round-trip mismatch for ${src}`);
  }
});

// Known, deliberate divergences from JSON.stringify(JSON.parse(x)).
Deno.test("negative zero keeps its sign", async () => {
  // JS prints -0 as "0", losing the sign bit. Emitting the source span verbatim
  // preserves it, which round-trips more information rather than less.
  const got = await canon("-0");
  assertEquals(got.err, ERR.NONE);
  assertEquals(got.text, "-0");
  assertEquals(JSON.stringify(JSON.parse("-0")), "0");
});

Deno.test("duplicate object keys are all retained", async () => {
  // JS keeps last-wins and collapses to one key. RFC 8259 leaves the behaviour
  // undefined, and a tree that drops members cannot round-trip its input.
  const got = await canon('{"a":1,"a":2}');
  assertEquals(got.err, ERR.NONE);
  assertEquals(got.text, '{"a":1,"a":2}');
  assertEquals(JSON.stringify(JSON.parse('{"a":1,"a":2}')), '{"a":2}');
});

Deno.test("deep nesting inside the depth limit", async () => {
  for (const depth of [1, 10, 100, 399]) {
    const src = "[".repeat(depth) + "]".repeat(depth);
    const got = await canon(src);
    assertEquals(got.err, ERR.NONE, `depth ${depth} should parse`);
    assertEquals(got.text, JSON.stringify(JSON.parse(src)));
  }
});

Deno.test("depth limit rejects rather than exhausting the stack", async () => {
  const src = "[".repeat(500) + "]".repeat(500);
  const got = await canon(src);
  assertEquals(got.err, ERR.DEPTH);
});
