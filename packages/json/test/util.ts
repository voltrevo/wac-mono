import { wacBind } from "../../../harness/wacBind.ts";

type JsonMod = {
  canonicalize(src: Uint8Array): Uint8Array;
  errorCode(src: Uint8Array): number;
  errorPos(src: Uint8Array): number;
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

export const ERR = {
  NONE: 0,
  UNEXPECTED: 1,
  EOF: 2,
  NUMBER: 3,
  STRING: 4,
  ESCAPE: 5,
  CONTROL: 6,
  TRAILING: 7,
  DEPTH: 8,
} as const;

export type Canon = { err: number; text: string };

/** Run canonicalize and split the leading status byte from the payload. */
export async function canon(src: string): Promise<Canon> {
  const m = await json();
  const out = m.canonicalize(enc.encode(src));
  return { err: out[0], text: dec.decode(out.subarray(1)) };
}

export async function numberValue(src: string): Promise<number> {
  const m = await json();
  return m.parseNumberValue(enc.encode(src));
}

export async function errorOf(src: string): Promise<number> {
  const m = await json();
  return m.errorCode(enc.encode(src));
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
