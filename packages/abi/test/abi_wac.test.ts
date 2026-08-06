// The ABI codec, against `ethers`.
//
// The corpus in `vendor/corpus.json` was produced by `npm:ethers@6` and committed — a few kilobytes, so the
// tests need no network and cannot silently start passing because a download failed. Each case carries the
// types, the encoding ethers produced, and a rendering of the values *as ethers decodes them*, so the wac
// side is compared against a value this repo did not compute. `tools/vendor.ts` regenerates it.
//
// Both directions, as `packages/rlp`'s tests do and for the same reason: an encoder and a decoder wrong in
// opposite ways agree with each other perfectly. So each case is decoded and rendered — compared against
// ethers — and then **re-encoded**, which must reproduce ethers' bytes exactly.
//
// The cases that matter are the nested ones. A head/tail implementation that measures offsets from the
// message rather than from the enclosing tuple passes every flat case in the corpus and fails
// `(uint256,string)[]`, `uint256[][]` and `((uint256,bool),(string,bytes))`.

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

const probe = await wacBind("packages/abi/test/wac/probe.wac") as Record<string, unknown>;
const decodeRender = probe.decodeRender as (data: Uint8Array, schema: Int32Array) => Uint8Array;
const roundTrip = probe.roundTrip as (data: Uint8Array, schema: Int32Array) => Uint8Array;
const encodeMismatch = probe.encodeMismatch as (kind: number, schema: Int32Array) => Uint8Array;
const tags = probe.tags as () => Int32Array;

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g)?.map((h) => parseInt(h, 16)) ?? []);

const T = {
  UINT: 1,
  BOOL: 2,
  ADDRESS: 3,
  BYTES32: 4,
  BYTES: 5,
  STRING: 6,
  ARRAY: 7,
  FIXED: 8,
  TUPLE: 9,
} as const;

/** An ethers type string as the descriptor `packages/abi` walks. */
function descriptor(type: string): number[] {
  if (type.endsWith("]")) {
    const open = type.lastIndexOf("[");
    const inner = type.slice(0, open);
    const size = type.slice(open + 1, -1);
    return size === ""
      ? [T.ARRAY, ...descriptor(inner)]
      : [T.FIXED, Number(size), ...descriptor(inner)];
  }
  if (type.startsWith("(")) {
    const members = splitTuple(type);
    return [T.TUPLE, members.length, ...members.flatMap(descriptor)];
  }
  if (type === "bool") return [T.BOOL];
  if (type === "address") return [T.ADDRESS];
  if (type === "bytes") return [T.BYTES];
  if (type === "string") return [T.STRING];
  if (type === "bytes32") return [T.BYTES32];
  if (type.startsWith("uint") || type.startsWith("int")) return [T.UINT];
  throw new Error(`no descriptor for ${type}`);
}

function splitTuple(t: string): string[] {
  const body = t.slice(1, -1);
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    if (i === body.length || (body[i] === "," && depth === 0)) {
      out.push(body.slice(start, i));
      start = i + 1;
    } else if (body[i] === "(") depth++;
    else if (body[i] === ")") depth--;
  }
  return out.filter((s) => s !== "");
}

type Case = { name: string; types: string[]; hex: string; rendering: string };
const corpus = JSON.parse(
  await Deno.readTextFile(new URL("./vendor/corpus.json", import.meta.url)),
) as { cases: Case[] };

if (corpus.cases.length < 25) {
  throw new Error(`only ${corpus.cases.length} cases — is the vendored corpus intact?`);
}

const schemaOf = (c: Case) => Int32Array.from(c.types.flatMap(descriptor));

function decoded(c: Case): { ok: boolean; text: string } {
  const out = decodeRender(unhex(c.hex), schemaOf(c));
  return { ok: out[0] === 1, text: new TextDecoder().decode(out.subarray(1)) };
}

Deno.test("every case decodes to what ethers says it means", () => {
  for (const c of corpus.cases) {
    const got = decoded(c);
    assertEquals(got.ok, true, `${c.name}: ${got.text}`);
    assertEquals(got.text, c.rendering, `${c.name} (${c.types.join(",")})`);
  }
});

Deno.test("and re-encodes to the bytes ethers produced", () => {
  // The encoder is checked against real bytes rather than against the decoder beside it: the tree came from
  // ethers' own encoding, and the test above established it is the right tree.
  for (const c of corpus.cases) {
    const back = roundTrip(unhex(c.hex), schemaOf(c));
    assertEquals(hex(back), c.hex, `${c.name} (${c.types.join(",")})`);
  }
});

Deno.test("the nested cases are actually in the corpus", () => {
  // A corpus that quietly lost its hard cases would leave both tests above passing and meaning much less.
  const names = corpus.cases.map((c) => c.types.join(","));
  for (const want of ["bytes,string[]", "uint256[][]", "(uint256,string)[]", "((uint256,bool),(string,bytes))"]) {
    assertEquals(names.includes(want), true, `the corpus has no ${want} case`);
  }
});

Deno.test("a malformed offset or length is refused, not read past", () => {
  // Reading past a field's own bounds is how this class of bug becomes a security one, so each of these is
  // built by hand from a valid encoding and must fail.
  const w = (n: number) => n.toString(16).padStart(64, "0");
  const bad: [string, string, string[]][] = [
    // An offset past the end of the payload.
    ["an offset past the end", w(0x400) + w(3) + "010203".padEnd(64, "0"), ["bytes"]],
    // An offset pointing back into the head, which is how one field is made to alias another.
    ["an offset into the head", w(0) + w(3) + "010203".padEnd(64, "0"), ["bytes"]],
    // A length longer than the bytes that follow it.
    ["a length past the end", w(0x20) + w(0x40) + "0102".padEnd(64, "0"), ["bytes"]],
    // An array claiming more elements than could fit.
    ["an array length past the end", w(0x20) + w(0x1000) + w(1), ["uint256[]"]],
    // A length that does not fit 32 bits at all.
    ["a 256-bit length", w(0x20) + "f".repeat(64), ["bytes"]],
    // Calldata that is not a whole number of words.
    ["a partial word", w(42).slice(0, 62), ["uint256"]],
    // A bool that is neither 0 nor 1, and an address with dirty high bytes.
    ["a bool of 2", w(2), ["bool"]],
    ["an address with high bytes set", "ff".repeat(32), ["address"]],
  ];
  for (const [what, payload, types] of bad) {
    const out = decodeRender(unhex(payload), Int32Array.from(types.flatMap(descriptor)));
    assertEquals(out[0], 0, `${what}: accepted, rendered ${new TextDecoder().decode(out.subarray(1))}`);
    assertEquals(
      new TextDecoder().decode(out.subarray(1)).length > 0,
      true,
      `${what}: refused without saying why`,
    );
  }
});

Deno.test("a value that does not fit its type is refused, not encoded as zeroes", () => {
  // The first version of `encode` answered 32 zero bytes for a `List` where the schema said `uint256`,
  // which is the worst answer an encoder of calldata can give: a caller whose tree was wrong would have got
  // well-formed bytes meaning a transfer of nothing to nobody, and no sign that anything had happened. Found
  // by reading, not by a test — nothing in the corpus can produce a mismatched tree, because every tree in it
  // came from decoding bytes that matched.
  const cases: [string, number, number[]][] = [
    ["a List where a uint belongs", 0, [T.UINT]],
    ["Bytes where a uint belongs", 1, [T.UINT]],
    ["a 31-byte word", 2, [T.UINT]],
    ["a Word where bytes belong", 3, [T.BYTES]],
    ["Bytes where an array belongs", 4, [T.ARRAY, T.UINT]],
  ];
  for (const [what, kind, schema] of cases) {
    const out = encodeMismatch(kind, Int32Array.from(schema));
    assertEquals(out[0], 0, `${what}: encoded anyway`);
    assertEquals(
      new TextDecoder().decode(out.subarray(1)).length > 0,
      true,
      `${what}: refused without saying why`,
    );
  }
});

Deno.test("the descriptor tags are the numbers this file thinks they are", () => {
  // The schema crosses the boundary as an `i32[]`, so the tags are a shared constant with a copy on each
  // side. Mutation testing found the drift this pins: replacing `T_UINT()` with 0 left every test passing,
  // because the descriptors built here and the constants compared there would *both* have been wrong in a
  // way that cancelled out — the decoder would fall through to its static path and answer correctly.
  const got = [...tags()];
  const want = [T.UINT, T.BOOL, T.ADDRESS, T.BYTES32, T.BYTES, T.STRING, T.ARRAY, T.FIXED, T.TUPLE];
  assertEquals(got.join(","), want.join(","), "abi.wac's tags and this file's have drifted");
  assertEquals(new Set(got).size, got.length, "two tags share a number");
});
