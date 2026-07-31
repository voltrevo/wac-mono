// Rung 2, the other half: the parser's *diagnostics* against the reference's.
//
// `test/parse.test.ts` compares ASTs over the corpus, which are all files that parse
// cleanly — so it says nothing about what either parser does with input that does not.
// That is half the parser's behaviour, and the half that rung 3 builds on: type
// checking compares diagnostics by position, so a recovery strategy that diverges here
// makes every rung above it diverge for reasons that have nothing to do with types.
//
// `api.wac` has exported `dumpErrors` for exactly this since the package was written,
// and until now nothing called it.
//
// Compared by count and position, not by message: the wac side reports numeric codes
// and the reference reports English, so the codes are checked by the order and place
// they occur in. That is weaker than comparing text, but it is the strongest
// comparison the two surfaces support, and position is the part callers depend on.
//
// Error *counts* here are often large and look arbitrary — `fn` alone produces
// thirteen. That is not a target anybody chose; it is what falls out of the
// reference's recovery, and matching it is the whole point. Where a count looks
// absurd, the reference is being absurd in exactly the same way, which is the property
// under test.

import { wacLex } from "wac/wacLex.ts";
import { wacParse } from "wac/wacParse.ts";
import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/wacc/src/api.wac");
const dumpErrors = mod.dumpErrors as (src: Uint8Array) => Int32Array;

type Diag = { line: number; col: number };

/** wacc's diagnostics, as (line, col) pairs — the code in each triple is dropped. */
function mine(source: string): Diag[] {
  const flat = Array.from(dumpErrors(new TextEncoder().encode(source)));
  const out: Diag[] = [];
  for (let i = 0; i < flat.length; i += 3) out.push({ line: flat[i + 1], col: flat[i + 2] });
  return out;
}

function reference(source: string): Diag[] {
  return wacParse(wacLex(source).tokens, "m.wac").errors.map(e => ({ line: e.line, col: e.col }));
}

const show = (ds: Diag[]) => ds.length === 0 ? "none" : ds.map(d => `${d.line}:${d.col}`).join(", ");

function agree(source: string): void {
  const a = mine(source), b = reference(source);
  if (a.length !== b.length || a.some((d, i) => d.line !== b[i].line || d.col !== b[i].col)) {
    throw new Error(
      `${JSON.stringify(source)}\n` +
      `  wacc      ${a.length} error(s): ${show(a)}\n` +
      `  reference ${b.length} error(s): ${show(b)}`);
  }
}

/** Every case in one test body would stop at the first divergence; this reports all. */
function agreeAll(label: string, sources: string[]): void {
  const failures: string[] = [];
  for (const source of sources) {
    try {
      agree(source);
    } catch (e) {
      failures.push((e as Error).message);
    }
  }
  if (failures.length > 0) {
    throw new Error(`${label}: ${failures.length} of ${sources.length} diverge\n\n${failures.join("\n\n")}`);
  }
}

Deno.test("parse errors: well-formed input produces none, on both sides", () => {
  agreeAll("clean", [
    "",
    "i32 f() { return 1; }",
    "i32 f() { for (;;) { } }",
    "struct S { i32 a; }\ni32 g(S s) { return s.a; }",
    'import { a as b, c } from "./m.wac";\nvoid f() { }',
  ]);
});

Deno.test("parse errors: a stray token at top level costs exactly one error", () => {
  // This is the case that was wrong. Anything that cannot begin a declaration used to
  // be handed to the function parser, which then reported a missing type, a missing
  // name, a missing parameter list and a missing body — a cascade for a single stray
  // character. `;;;` gave eleven errors against the reference's three, and a stray `}`
  // after a complete function gave seven against one. The fix was to check the token
  // can start a declaration before trying, which is what the reference does.
  agreeAll("stray", [
    ";", ";;;", "}", "{", ")", "]", "?", ",", ":", "@#$",
    "123", "1.5", '"str"', "= 1;", "i32 f() { return 1; } }",
    "i32 f() {} ; i32 g() {}",
    ";i32 f() { return 1; }",
    "i32 f() { return 1; };;",
  ]);
});

Deno.test("parse errors: truncation at every point in a declaration", () => {
  // Each prefix stops one token later than the last, so the parser hits EOF in a
  // different state each time. Truncation is the most common real malformation — it is
  // what an editor sees on every keystroke — and it is where a hand-written recursive
  // descent parser is most likely to differ from another one.
  agreeAll("truncated", [
    "i32", "i32 f", "i32 f(", "i32 f()", "i32 f() {", "i32 f() { return",
    "i32 f() { return 1", "i32 f() { return 1;",
    "struct", "struct S", "struct S {", "struct S { i32", "struct S { i32 a",
    "enum", "enum E", "enum E {", "enum E { A", "enum E { A,",
    "const", "const i32", "const i32 X", "const i32 X =",
    "import", "import x", "import {", "import { a", "import { a }",
    "import { a } from", 'import { a } from "',
    "export", "export ", "export i32", "export struct", "export enum", "export const",
    "fn", "void", "void f", "void f(",
  ]);
});

Deno.test("parse errors: malformation inside an otherwise well-formed declaration", () => {
  agreeAll("malformed", [
    "i32 f( { return 1; }",
    "i32 f() { return 1 }",
    "i32 f() { i32 x = ; }",
    "i32 f() { x = = 1; }",
    "i32 f() { if x { } }",
    "i32 f() { while { } }",
    "i32 f() { match x { } }",
    "i32 f() { return 1;; }",
    "i32 f(i32) { return 1; }",
    "i32 f(i32 a,,) { return a; }",
    "f() { }",
    "struct S { i32 a }",
    "struct S { i32; }",
    "enum E { A(, }",
    "export export",
    "export ;",
    "i32 f() { s.; }",
    "i32 f() { return (1; }",
    "i32 f() { i32[] a = i32[; }",
    "i32 f() { return 1 as; }",
  ]);
});

Deno.test("parse errors: positions are on the offending token, across lines", () => {
  // Multi-line sources are the case where a column is right and a line is wrong, or the
  // two are computed from different token indices. Every case above is single-line, so
  // a line number that was always 1 would pass all of them.
  agreeAll("multiline", [
    "i32 f() {\n  return 1\n}",
    "i32 f() {\n}\n;\n",
    "struct S {\n  i32 a\n}",
    "i32 f() {\n  i32 x = ;\n  return x;\n}",
    "\n\n\n}",
    "i32 f() { return 1; }\n\n\n\nstruct S {",
    "// a comment\n/* and a block\n   comment */\n;",
  ]);
});
