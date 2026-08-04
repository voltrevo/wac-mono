// Container merkleization against Ethereum's `ssz_generic` container vectors.
//
// 303 of the 403 container cases: `SingleFieldTestStruct`, `SmallTestStruct`, `FixedTestStruct`,
// `VarTestStruct`, `ComplexTestStruct`, `BitsStruct`. The other 100 are `ProgressiveTestStruct` and
// `ProgressiveBitsStruct`, which merkleize under the progressive-list scheme — a different algorithm
// that an Altair light client does not use. Out of scope and said so in the README, not skipped
// quietly.
//
// The layouts below are transcribed from `consensus-specs/tests/formats/ssz_generic/README.md`, which
// is where the generator's own definitions live, rather than remembered. `ComplexTestStruct` is the
// one that matters: seven fields, four of them variable, one nested container, a vector of fixed
// containers and a vector of *variable* containers. If offsets are read wrong, that is the case that
// says so.

import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/ssz/test/wac/probe.wac") as unknown as {
  sszHashTreeRoot(types: Int32Array, fields: Int32Array, root: number, data: Uint8Array): Uint8Array;
  sszIsFixed(types: Int32Array, fields: Int32Array, i: number): boolean;
  sszFixedSize(types: Int32Array, fields: Int32Array, i: number): number;
};

const KIND = { BASIC: 0, BITVECTOR: 1, BITLIST: 2, VECTOR: 3, LIST: 4, CONTAINER: 5 };

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
const byte = s.basic(1);
const uint8 = byte;
const uint16 = s.basic(2);
const uint32 = s.basic(4);
const uint64 = s.basic(8);

const SingleFieldTestStruct = s.container([byte]);
const SmallTestStruct = s.container([uint16, uint16]);
const FixedTestStruct = s.container([uint8, uint64, uint32]);
const VarTestStruct = s.container([uint16, s.list(uint16, 1024), uint8]);
const ComplexTestStruct = s.container([
  uint16,
  s.list(uint16, 128),
  uint8,
  s.list(byte, 256), //                              ByteList[256]
  VarTestStruct,
  s.vector(FixedTestStruct, 4),
  s.vector(VarTestStruct, 2),
]);
const BitsStruct = s.container([
  s.bitlist(5),
  s.bitvector(2),
  s.bitvector(1),
  s.bitlist(6),
  s.bitvector(8),
]);

const ROOT: Record<string, number> = {
  SingleFieldTestStruct,
  SmallTestStruct,
  FixedTestStruct,
  VarTestStruct,
  ComplexTestStruct,
  BitsStruct,
};

type Case = { type: string; case: string; ssz: string; root: string };
const fixture = JSON.parse(
  await Deno.readTextFile(new URL("vendor/ssz_generic_valid.json", import.meta.url)),
) as { cases: Case[] };

const bytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const structOf = (name: string) => name.replace(/_(zero|max|nil|one|lengthy|random).*$/, "");

Deno.test("the classic ssz_generic containers merkleize to Ethereum's roots", () => {
  const per: Record<string, number> = {};
  const failures: string[] = [];
  for (const c of fixture.cases) {
    if (c.type !== "containers") continue;
    const root = ROOT[structOf(c.case)];
    if (root === undefined) continue; //             the two progressive structs
    per[structOf(c.case)] = (per[structOf(c.case)] ?? 0) + 1;
    const got = mod.sszHashTreeRoot(s.t, s.f, root, bytes(c.ssz));
    if (hex(got) !== c.root) {
      if (failures.length < 6) {
        failures.push(`${c.case}\n    got  ${got.length === 0 ? "(refused)" : hex(got)}\n    want ${c.root}`);
      }
    }
  }
  if (failures.length > 0) throw new Error(`${failures.length}+ mismatches:\n  ${failures.join("\n  ")}`);
  const want = {
    SingleFieldTestStruct: 21, SmallTestStruct: 21, FixedTestStruct: 21,
    VarTestStruct: 80, ComplexTestStruct: 80, BitsStruct: 80,
  };
  for (const [k, n] of Object.entries(want)) {
    if (per[k] !== n) throw new Error(`drove ${per[k] ?? 0} ${k} cases, expected ${n}`);
  }
});

Deno.test("fixed and variable are classified the way the offsets depend on", () => {
  // `isFixed` decides whether a field is inline or behind an offset, so getting it wrong corrupts
  // every serialization that contains the type. Sizes are from the layouts, computed by hand.
  const cases: [string, number, boolean, number][] = [
    ["SingleFieldTestStruct", SingleFieldTestStruct, true, 1],
    ["SmallTestStruct", SmallTestStruct, true, 4],
    ["FixedTestStruct", FixedTestStruct, true, 1 + 8 + 4],
    ["VarTestStruct", VarTestStruct, false, 0], //     has a List, so variable
    ["ComplexTestStruct", ComplexTestStruct, false, 0],
    ["BitsStruct", BitsStruct, false, 0], //           BitList makes it variable
    ["Vector[FixedTestStruct, 4]", s.vector(FixedTestStruct, 4), true, 4 * 13],
    ["Vector[VarTestStruct, 2]", s.vector(VarTestStruct, 2), false, 0],
    ["Bitvector[8]", s.bitvector(8), true, 1],
    ["Bitvector[9]", s.bitvector(9), true, 2],
  ];
  for (const [name, i, fixed, size] of cases) {
    if (mod.sszIsFixed(s.t, s.f, i) !== fixed) {
      throw new Error(`${name}: isFixed said ${!fixed}`);
    }
    if (fixed && mod.sszFixedSize(s.t, s.f, i) !== size) {
      throw new Error(`${name}: fixedSize said ${mod.sszFixedSize(s.t, s.f, i)}, want ${size}`);
    }
  }
});

Deno.test("malformed offsets are refused, not decoded", () => {
  // Every one of these is a real serialization with one thing changed, so the only difference between
  // accepting and refusing is the check being tested. The invalid vectors are not vendored yet (they
  // need this decoder to exist first), so these are built by hand from a valid case.
  const valid = fixture.cases.find((c) =>
    c.type === "containers" && structOf(c.case) === "VarTestStruct" && c.ssz.length > 20
  );
  if (valid === undefined) throw new Error("no VarTestStruct case to perturb");
  const good = bytes(valid.ssz);
  if (mod.sszHashTreeRoot(s.t, s.f, VarTestStruct, good).length === 0) {
    throw new Error("the unmodified case was refused, so the negatives below prove nothing");
  }

  // VarTestStruct is uint16, offset(4), uint8 — so the offset sits at bytes 2..6 and must be 7.
  const readOff = (b: Uint8Array) => b[2] | (b[3] << 8) | (b[4] << 16) | (b[5] << 24);
  if (readOff(good) !== 7) throw new Error(`expected the fixed part to be 7 bytes, offset says ${readOff(good)}`);

  const withOffset = (v: number) => {
    const b = good.slice();
    b[2] = v & 0xff;
    b[3] = (v >> 8) & 0xff;
    b[4] = (v >> 16) & 0xff;
    b[5] = (v >> 24) & 0xff;
    return b;
  };
  // The offsets have to be chosen so that *only* the offset check can reject them. `B` is a
  // `List[uint16, 1024]`, so any offset leaving an odd number of bytes is refused by the element-size
  // check instead — which is how the first version of this test passed while the offset check was
  // removed. Parity-preserving offsets (same parity as the 7-byte fixed part) close that escape.
  const parityOk = (v: number) => (good.length - v) % 2 === 0;
  const bad: [string, number][] = [["past the end", good.length + 1]];
  for (const v of [1, 3, 5]) if (parityOk(v)) bad.push([`before the fixed part`, v]);
  for (const v of [9, 11, 13]) if (parityOk(v) && v <= good.length) bad.push([`after it`, v]);
  if (bad.length < 3) throw new Error(`only ${bad.length} usable offsets for a ${good.length}-byte case`);
  for (const [why, v] of bad) {
    if (mod.sszHashTreeRoot(s.t, s.f, VarTestStruct, withOffset(v)).length !== 0) {
      throw new Error(`an offset ${why} (${v}) was accepted`);
    }
  }
  // Truncated below the fixed part cannot even hold the offsets.
  if (mod.sszHashTreeRoot(s.t, s.f, VarTestStruct, good.slice(0, 5)).length !== 0) {
    throw new Error("a container shorter than its fixed part was accepted");
  }
});
