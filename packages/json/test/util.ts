import { wacBind } from "../../../harness/wacBind.ts";

/** The generated class for `json.wac`'s `Canonical` struct. */
type CanonicalRef = {
  readonly ok: boolean;
  readonly code: number;
  readonly pos: number;
  readonly text: Uint8Array;
};

type JsonMod = {
  canonicalize(src: Uint8Array): CanonicalRef;
  parseNumberValue(src: Uint8Array): number;
};

// One compile for the whole test run — wacBind writes a bindgen'd module under
// .cache/ and importing it twice would recompile for nothing.
let cached: JsonMod | null = null;

export async function json(): Promise<JsonMod> {
  if (cached === null) cached = await wacBind("packages/json/src/json.wac") as unknown as JsonMod;
  return cached;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Error codes, mirrored from `src/parse.wac`.
 *
 * A hand-kept copy of a list in another language, which is exactly the kind of thing
 * that drifts silently — add a code on the wac side and every test here keeps passing
 * against the old numbering. `errorCodesAgree` below reads the wac source and checks
 * the two lists match, so a drift fails a test instead of a document.
 */
export const ERR = {
  NONE: 0,
  UNEXPECTED: 1,
  EOF: 2,
  NUMBER: 3,
  ESCAPE: 4,
  CONTROL: 5,
  TRAILING: 6,
  DEPTH: 7,
  UTF8: 8,
} as const;

/**
 * Check ERR against the `ERR_*` declarations in the parser.
 *
 * Derived rather than trusted, the same way wacc's token-kind test reads its order
 * from `wacLex.ts` instead of keeping a copy.
 */
export async function errorCodesAgree(expected: Record<string, number> = ERR): Promise<string[]> {
  const src = await Deno.readTextFile("packages/json/src/parse.wac");
  const found = new Map<string, number>();
  for (const m of src.matchAll(/export i32 ERR_([A-Z0-9]+)\(\)\s*\{\s*return\s+(\d+);/g)) {
    found.set(m[1], Number(m[2]));
  }
  const problems: string[] = [];
  for (const [name, code] of Object.entries(expected)) {
    if (!found.has(name)) problems.push(`ERR.${name} = ${code} has no ERR_${name}() in parse.wac`);
    else if (found.get(name) !== code) problems.push(`ERR.${name} is ${code}, ERR_${name}() returns ${found.get(name)}`);
  }
  for (const [name, code] of found) {
    if (!(name in expected)) problems.push(`ERR_${name}() = ${code} is missing from ERR`);
  }
  return problems;
}

export type Canon = { err: number; text: string };

/**
 * Run canonicalize.
 *
 * This used to split a status byte off the front of the payload, because an export returned one
 * value and there was nowhere else to put the error. `Canonical` is a struct now and crosses as
 * one, so the outcome and the output are separate fields rather than a convention.
 */
export async function canon(src: string): Promise<Canon> {
  const m = await json();
  const out = m.canonicalize(enc.encode(src));
  return { err: out.code, text: dec.decode(out.text) };
}

export async function numberValue(src: string): Promise<number> {
  const m = await json();
  return m.parseNumberValue(enc.encode(src));
}

export async function errorOf(src: string): Promise<number> {
  const m = await json();
  return m.canonicalize(enc.encode(src)).code;
}

/**
 * Error code for raw bytes.
 *
 * Needed wherever the input is not valid UTF-8: passing such bytes through a JS
 * string and back re-encodes them (0xC3 becomes C3 83), so the parser would never
 * see the sequence under test.
 */
export async function errorOfBytes(bytes: Uint8Array): Promise<number> {
  const m = await json();
  return m.canonicalize(bytes).code;
}

// Own assertions rather than jsr:@std/assert — the wac projects carry no
// external dependencies, and this sandbox has no route to the registry anyway.

export function assertEquals<T>(got: T, want: T, msg?: string): void {
  if (got !== want) {
    const detail = msg === undefined ? "" : ` — ${msg}`;
    throw new Error(
      `assertEquals failed${detail}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`,
    );
  }
}

/** Bit-exact float comparison: -0 !== 0, and NaN equals NaN. */
export function assertSameNumber(got: number, want: number, msg?: string): void {
  if (!Object.is(got, want)) {
    const detail = msg === undefined ? "" : ` — ${msg}`;
    throw new Error(`assertSameNumber failed${detail}\n  got:  ${got}\n  want: ${want}`);
  }
}
