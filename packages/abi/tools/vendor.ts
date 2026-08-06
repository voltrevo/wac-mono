// Generates `test/vendor/corpus.json` from `ethers`, which is the oracle for `packages/abi`.
//
//     deno run -A packages/abi/tools/vendor.ts > packages/abi/test/vendor/corpus.json
//
// **Run by hand, not by the suite.** The corpus is committed — a few kilobytes — so the tests need no
// network and cannot silently start passing because a download failed, which is the property
// `packages/bls/test/vendor/README.md` states and `harness/fixtures.ts` is built to preserve. `ethers` is a
// dev-time dependency of *this file* and of nothing else in the repo.
//
// Each case carries three things: the type list as ethers spells it, the encoding ethers produces, and a
// rendering of the values in the canonical form `test/abi_wac.test.ts` compares against. The rendering is
// derived here from ethers' own decode, so the wac side is checked against a value this repo did not
// compute.

import { AbiCoder } from "npm:ethers@6";

const coder = AbiCoder.defaultAbiCoder();

/** The canonical rendering: one shape per value, and no two values alike. */
function render(type: string, v: unknown): string {
  if (type.endsWith("]")) {
    const inner = type.slice(0, type.lastIndexOf("["));
    return `[${(v as unknown[]).map((x) => render(inner, x)).join(",")}]`;
  }
  if (type.startsWith("(")) {
    const parts = splitTuple(type);
    return `(${parts.map((t, i) => render(t, (v as unknown[])[i])).join(",")})`;
  }
  if (type === "bool") return (v as boolean) ? "b1" : "b0";
  if (type === "address") return `a${(v as string).slice(2).toLowerCase()}`;
  if (type === "string") return `s${hex(new TextEncoder().encode(v as string))}`;
  if (type === "bytes" || type.startsWith("bytes")) return `x${(v as string).slice(2)}`;
  if (type.startsWith("uint") || type.startsWith("int")) return `u${(v as bigint).toString(16)}`;
  throw new Error(`no rendering for ${type}`);
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** `(a,(b,c),d)` into its top-level members. */
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

const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");

/**
 * The corpus. Flat cases first, then the ones a head/tail implementation gets wrong: a dynamic type inside
 * an array, an array of arrays, a tuple whose members are dynamic, and the empty cases of each.
 */
const CASES: [name: string, types: string[], values: unknown[]][] = [
  ["one uint", ["uint256"], [42n]],
  ["max uint", ["uint256"], [(1n << 256n) - 1n]],
  ["zero uint", ["uint256"], [0n]],
  ["bool pair", ["bool", "bool"], [true, false]],
  ["address", ["address"], [A(0x1234)]],
  ["bytes32", ["bytes32"], ["0x" + "ab".repeat(32)]],
  ["static mix", ["uint256", "address", "bool"], [7n, A(9), true]],
  ["empty bytes", ["bytes"], ["0x"]],
  ["short bytes", ["bytes"], ["0x010203"]],
  ["bytes crossing a word", ["bytes"], ["0x" + "cd".repeat(33)]],
  ["empty string", ["string"], [""]],
  ["a string", ["string"], ["hello"]],
  ["a long string", ["string"], ["x".repeat(100)]],
  ["static after dynamic", ["bytes", "uint256"], ["0x0102", 5n]],
  ["dynamic after static", ["uint256", "bytes"], [5n, "0x0102"]],
  ["two dynamics", ["bytes", "string"], ["0x01", "two"]],
  ["empty array", ["uint256[]"], [[]]],
  ["uint array", ["uint256[]"], [[1n, 2n, 3n]]],
  ["address array", ["address[]"], [[A(1), A(2)]]],
  ["string array", ["string[]"], [["a", "bb", "ccc"]]],
  ["bytes array", ["bytes[]"], [["0x01", "0x0203"]]],
  ["array of arrays", ["uint256[][]"], [[[1n], [2n, 3n], []]]],
  ["fixed array", ["uint256[2]"], [[1n, 2n]]],
  ["fixed array of dynamic", ["string[2]"], [["a", "b"]]],
  ["tuple, static", ["(uint256,bool)"], [[1n, true]]],
  ["tuple with a dynamic member", ["(uint256,string)"], [[1n, "hi"]]],
  ["tuple of tuples", ["((uint256,bool),(string,bytes))"], [[[1n, false], ["s", "0x0a"]]]],
  ["array of tuples", ["(uint256,string)[]"], [[[1n, "a"], [2n, "bb"]]]],
  ["the shape 0085 names", ["bytes", "string[]"], ["0x010203", ["a", "bb"]]],
  ["everything at once", ["uint256", "bytes", "address[]", "(bool,string)"], [
    255n,
    "0x" + "ff".repeat(40),
    [A(1), A(2), A(3)],
    [true, "nested"],
  ]],
];

const out = CASES.map(([name, types, values]) => {
  const encoded = coder.encode(types, values);
  // Rendered from ethers' *decode* of its own encoding rather than from the literals above, so the corpus
  // records what the oracle says the bytes mean and not what this file meant to write.
  const back = coder.decode(types, encoded);
  return {
    name,
    types,
    hex: encoded.slice(2),
    rendering: types.map((t, i) => render(t, back[i])).join("|"),
  };
});

console.log(JSON.stringify({
  source: "npm:ethers@6, AbiCoder.defaultAbiCoder()",
  rebuild: "deno run -A packages/abi/tools/vendor.ts > packages/abi/test/vendor/corpus.json",
  cases: out,
}, null, 2));
