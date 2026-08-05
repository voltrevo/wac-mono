// Ethereum's `ssz_generic` **invalid** vectors — 1,131 encodings that must be refused.
//
// Every other suite here asks "do you agree with the answer". This one asks "do you refuse", which is
// a different and in some ways stronger question: an invalid case ships `serialized.ssz_snappy` alone
// with no `meta.yaml`, because there *is* no correct root. So this test cannot be wrong about an
// expected value — only about whether a refusal happened.
//
// Why it matters more than a completeness exercise. A malformed SSZ object that merkleizes anyway
// produces a root, and a root is what consensus is *about*. Two clients that disagree on whether an
// encoding is legal disagree on a `hash_tree_root`, which is a chain split. `packages/lightclient`
// reads `LightClientUpdate`s handed to it by an untrusted peer; every one of the container faults
// below — a zeroed offset, an offset one byte past the end, a trailing byte — is something that peer
// can send.
//
// ## What these vectors found
//
// **`boolean` did not exist as a type.** `packages/ssz` had `KIND_BASIC` with a byte width, so a
// boolean was a `uint8` and `0x02` was a perfectly good one. 84 of these cases are exactly that, and
// all 84 were accepted before `KIND_BOOLEAN` was added. It is not cosmetic: SSZ merkleizes a boolean
// into a chunk padded with 31 zero bytes, so `0x02` and `0x01` have *different* roots, and accepting
// both means two encodings of "true" that do not agree on the hash tree.
//
// ## Coverage, and what is left out
//
// `Progressive*` is excluded, as in the valid suite — a merkleization scheme this package does not
// implement — and the generator reports the count so the exclusion is visible. Everything else is
// here: 957 `basic_vector`, 104 `containers`, 31 `bitvector`, 18 `uints`, 17 `bitlist`, 4 `boolean`.
//
// A case whose name this file cannot parse is a **failure**, not a skip. The type has to be recovered
// from the directory name (`vec_uint16_5_nil`, `bitlist_2_but_3`, `ComplexTestStruct_offset_zeroed`),
// and a parser that quietly dropped the names it did not understand would report a smaller, cleaner,
// meaningless number.

import { wacBind } from "../../../harness/wacBind.ts";
import { fixtureJson, type FixtureManifest } from "../../../harness/fixtures.ts";

const manifest = JSON.parse(
  await Deno.readTextFile(new URL("fixtures.json", import.meta.url)),
) as FixtureManifest;

const mod = await wacBind("packages/ssz/test/wac/probe.wac") as unknown as {
  sszHashTreeRoot(types: Int32Array, fields: Int32Array, root: number, data: Uint8Array): Uint8Array;
};

const KIND = { BASIC: 0, BITVECTOR: 1, BITLIST: 2, VECTOR: 3, LIST: 4, CONTAINER: 5, BOOLEAN: 6 };

/** Builds the flat `[kind, param, child, count]` table the wac side reads. */
class Schema {
  types: number[] = [];
  fields: number[] = [];
  private add(kind: number, param: number, child: number, count: number): number {
    const i = this.types.length / 4;
    this.types.push(kind, param, child, count);
    return i;
  }
  basic(bytes: number) { return this.add(KIND.BASIC, bytes, 0, 0); }
  boolean() { return this.add(KIND.BOOLEAN, 1, 0, 0); }
  bitvector(n: number) { return this.add(KIND.BITVECTOR, n, 0, 0); }
  bitlist(limit: number) { return this.add(KIND.BITLIST, limit, 0, 0); }
  vector(elem: number, n: number) { return this.add(KIND.VECTOR, n, elem, 0); }
  list(elem: number, limit: number) { return this.add(KIND.LIST, limit, elem, 0); }
  container(fieldTypes: number[]) {
    const at = this.fields.length;
    this.fields.push(...fieldTypes);
    return this.add(KIND.CONTAINER, 0, at, fieldTypes.length);
  }
  get t() { return new Int32Array(this.types); }
  get f() { return new Int32Array(this.fields); }
}

const s = new Schema();
const bool = s.boolean();
const byte = s.basic(1);
const uint8 = byte, uint16 = s.basic(2), uint32 = s.basic(4), uint64 = s.basic(8);
const uint128 = s.basic(16), uint256 = s.basic(32);
const UINT: Record<string, number> = {
  uint8, uint16, uint32, uint64, uint128, uint256,
  "8": uint8, "16": uint16, "32": uint32, "64": uint64, "128": uint128, "256": uint256,
};

// The six container definitions, transcribed from `consensus-specs/tests/formats/ssz_generic/README.md`
// exactly as in `container_wac.test.ts`. Duplicated rather than shared because the two files disagree
// about what they are for: one asserts roots, this one asserts refusals, and a shared fixture module
// would make a change to either silently change the other.
const SingleFieldTestStruct = s.container([byte]);
const SmallTestStruct = s.container([uint16, uint16]);
const FixedTestStruct = s.container([uint8, uint64, uint32]);
const VarTestStruct = s.container([uint16, s.list(uint16, 1024), uint8]);
const ComplexTestStruct = s.container([
  uint16,
  s.list(uint16, 128),
  uint8,
  s.list(byte, 256),
  VarTestStruct,
  s.vector(FixedTestStruct, 4),
  s.vector(VarTestStruct, 2),
]);
const BitsStruct = s.container([
  s.bitlist(5), s.bitvector(2), s.bitvector(1), s.bitlist(6), s.bitvector(8),
]);
const CONTAINER: Record<string, number> = {
  SingleFieldTestStruct, SmallTestStruct, FixedTestStruct, VarTestStruct, ComplexTestStruct,
  BitsStruct,
};

// Vector and bitlist types are built on demand and memoised, since 957 cases name perhaps 80 distinct
// ones and each `Schema.add` is a new table entry.
const memo = new Map<string, number>();
const once = (key: string, make: () => number) => {
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const made = make();
  memo.set(key, made);
  return made;
};

/**
 * The type a case name refers to, or null if the name is not understood.
 *
 * Null is a test failure, not a skip — see the header.
 */
function typeOf(group: string, name: string): number | null {
  let m: RegExpMatchArray | null;

  if (group === "boolean") return name.startsWith("byte_") ? bool : null;

  if (group === "uints") {
    m = name.match(/^uint_(\d+)_/);
    return m && UINT[m[1]] !== undefined ? UINT[m[1]] : null;
  }

  if (group === "bitvector") {
    // `bitvec_0`, `bitvec_16_max_8`. The first number is the bitvector's own N; anything after is
    // the fault's parameter.
    m = name.match(/^bitvec_(\d+)/);
    return m ? once(`bv${m[1]}`, () => s.bitvector(Number(m![1]))) : null;
  }

  if (group === "bitlist") {
    // `bitlist_2_but_3` — limit 2, given 3 bits.
    m = name.match(/^bitlist_(\d+)_but_/);
    if (m) return once(`bl${m[1]}`, () => s.bitlist(Number(m![1])));
    // `bitlist_no_delimiter_*` names no limit, because the fault is the absent delimiter byte and
    // holds at every limit. A generous one is used, so the refusal cannot be the limit's doing.
    if (name.startsWith("bitlist_no_delimiter")) return once("bl512", () => s.bitlist(512));
    return null;
  }

  if (group === "basic_vector") {
    // `vec_bool_4_nil`, `vec_uint16_5_max_one_less`, and the bare `vec_bool_0` / `vec_uint8_0`.
    m = name.match(/^vec_(bool|uint\d+)_(\d+)(?:_|$)/);
    if (!m) return null;
    const elem = m[1] === "bool" ? bool : UINT[m[1]];
    if (elem === undefined) return null;
    return once(`v${m[1]}x${m[2]}`, () => s.vector(elem, Number(m![2])));
  }

  if (group === "containers") {
    // The type is the longest known container name that prefixes the case.
    const hit = Object.keys(CONTAINER)
      .filter((k) => name === k || name.startsWith(k + "_"))
      .sort((a, b) => b.length - a.length)[0];
    return hit === undefined ? null : CONTAINER[hit];
  }
  return null;
}

type Case = { group: string; case: string; ssz: string };
const fixture = await fixtureJson<{ cases: Case[]; skippedProgressive: number }>(
  "ssz",
  "ssz_generic_invalid",
  manifest,
);
const bytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));

Deno.test("every invalid ssz_generic encoding is refused", () => {
  const unparsed: string[] = [];
  const accepted: string[] = [];
  const byGroup = new Map<string, number>();

  for (const c of fixture.cases) {
    const ty = typeOf(c.group, c.case);
    if (ty === null) {
      unparsed.push(`${c.group}/${c.case}`);
      continue;
    }
    // The probe returns an empty array where the wac side returns null.
    const root = mod.sszHashTreeRoot(s.t, s.f, ty, bytes(c.ssz));
    if (root.length !== 0) accepted.push(`${c.group}/${c.case}`);
    byGroup.set(c.group, (byGroup.get(c.group) ?? 0) + 1);
  }

  if (unparsed.length > 0) {
    throw new Error(
      `${unparsed.length} case names were not understood, so they tested nothing:\n  ` +
        unparsed.slice(0, 20).join("\n  ") + (unparsed.length > 20 ? "\n  …" : ""),
    );
  }
  if (accepted.length > 0) {
    throw new Error(
      `${accepted.length} of ${fixture.cases.length} invalid encodings produced a root:\n  ` +
        accepted.slice(0, 25).join("\n  ") + (accepted.length > 25 ? "\n  …" : ""),
    );
  }

  // Counts, so a fixture that loses cases fails instead of passing faster.
  const want: Record<string, number> = {
    basic_vector: 957, containers: 104, bitvector: 31, uints: 18, bitlist: 17, boolean: 4,
  };
  for (const [g, n] of Object.entries(want)) {
    if (byGroup.get(g) !== n) throw new Error(`${g}: ran ${byGroup.get(g)} cases, expected ${n}`);
  }
  if (fixture.cases.length !== 1131) {
    throw new Error(`expected 1131 cases, got ${fixture.cases.length}`);
  }
  if (fixture.skippedProgressive !== 132) {
    throw new Error(
      `the generator skipped ${fixture.skippedProgressive} Progressive* cases, expected 132 — ` +
        `if that number moved, the exclusion needs re-reading rather than the constant updating`,
    );
  }
});

Deno.test("the refusals are not vacuous — the same shapes, valid, are accepted", () => {
  // A `hashTreeRoot` that returned null unconditionally passes the test above. So each group's
  // *valid* counterpart must produce a root, hand-built here rather than taken from a vector file.
  const ok = (ty: number, data: Uint8Array, what: string) => {
    if (mod.sszHashTreeRoot(s.t, s.f, ty, data).length !== 32) {
      throw new Error(`a valid ${what} was refused`);
    }
  };
  const no = (ty: number, data: Uint8Array, what: string) => {
    if (mod.sszHashTreeRoot(s.t, s.f, ty, data).length !== 0) {
      throw new Error(`an invalid ${what} was accepted`);
    }
  };

  ok(bool, new Uint8Array([0]), "boolean false");
  ok(bool, new Uint8Array([1]), "boolean true");
  no(bool, new Uint8Array([2]), "boolean 0x02");
  no(bool, new Uint8Array([]), "zero-length boolean");
  no(bool, new Uint8Array([1, 0]), "two-byte boolean");

  const vecBool4 = s.vector(bool, 4);
  ok(vecBool4, new Uint8Array([1, 0, 1, 0]), "Vector[boolean, 4]");
  no(vecBool4, new Uint8Array([1, 0, 2, 0]), "Vector[boolean, 4] holding 0x02");
  no(vecBool4, new Uint8Array([1, 0, 1]), "Vector[boolean, 4] one byte short");

  ok(uint16, new Uint8Array([0xff, 0xff]), "uint16");
  no(uint16, new Uint8Array([0xff]), "short uint16");
  no(uint16, new Uint8Array([0, 0, 0]), "long uint16");

  const bl4 = s.bitlist(4);
  ok(bl4, new Uint8Array([0b10011]), "Bitlist[4] with 4 bits");   // delimiter at bit 4
  no(bl4, new Uint8Array([0b100011]), "Bitlist[4] with 5 bits");
  no(bl4, new Uint8Array([0]), "Bitlist[4] with no delimiter");
  no(bl4, new Uint8Array([]), "empty Bitlist[4]");

  const bv8 = s.bitvector(8);
  ok(bv8, new Uint8Array([0xff]), "Bitvector[8]");
  no(bv8, new Uint8Array([0xff, 0]), "Bitvector[8] with a trailing byte");

  // A container, with and without its trailing byte: the fault class that dominates the vectors.
  const good = new Uint8Array([0x2a, 0x00, 0x00, 0x00]);      // SmallTestStruct{42, 0}
  ok(SmallTestStruct, good, "SmallTestStruct");
  no(SmallTestStruct, new Uint8Array([...good, 0]), "SmallTestStruct with an extra byte");
});
