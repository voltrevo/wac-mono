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
import {
  declaredCodes,
  type Observed,
  PARSE_CODE_VALUES,
  relationFaults,
  shapeOf,
} from "./errorCodes.ts";
import { wacBind } from "../../../harness/wacBind.ts";

const mod = await wacBind("packages/wacc/src/api.wac");
const dumpErrors = mod.dumpErrors as (src: Uint8Array) => Int32Array;

type Diag = { line: number; col: number; code: number };

/** Every (reference message shape, wacc code) pair the cases below produce, checked at the end. */
const OBSERVED: Observed[] = [];
type RefDiag = { line: number; col: number; message: string };

/** wacc's diagnostics: line, col, **and the code**, which this file used to drop. */
function mine(source: string): Diag[] {
  const flat = Array.from(dumpErrors(new TextEncoder().encode(source)));
  const out: Diag[] = [];
  for (let i = 0; i < flat.length; i += 3) out.push({ code: flat[i], line: flat[i + 1], col: flat[i + 2] });
  return out;
}

function reference(source: string): RefDiag[] {
  return wacParse(wacLex(source).tokens, "m.wac").errors.map(
    (e) => ({ line: e.line, col: e.col, message: e.message }),
  );
}

const show = (ds: { line: number; col: number }[]) =>
  ds.length === 0 ? "none" : ds.map((d) => `${d.line}:${d.col}`).join(", ");

function agree(source: string): void {
  const a = mine(source), b = reference(source);
  if (a.length !== b.length || a.some((d, i) => d.line !== b[i].line || d.col !== b[i].col)) {
    throw new Error(
      `${JSON.stringify(source)}\n` +
      `  wacc      ${a.length} error(s): ${show(a)}\n` +
      `  reference ${b.length} error(s): ${show(b)}`);
  }
  // **And what each one says went wrong**, which was dropped: a mutation sweep put `return 0` in place of
  // every `perr*` constant and this suite stayed green. The codes are collected here and checked as a
  // relation once at the end — see `errorCodes.ts` for why the parser gets consistency and discrimination
  // rather than a table of meanings. wac-mono 0005.
  for (let i = 0; i < a.length; i++) {
    // **Checked here, not only in the summary at the end.** A mutation sweep runs the tests that *cover*
    // the mutated line, and a check living in its own test — one that executes no parser code — is never
    // selected. So every `perr*` constant survived the sweep even though the summary would have caught
    // them in a full run: the assertion has to sit in the test whose coverage reaches the line.
    // wac-mono 0005.
    if (!PARSE_CODE_VALUES.has(a[i].code)) {
      throw new Error(
        `${JSON.stringify(source)}: error ${i} came back as code ${a[i].code}, which no constant in ` +
          `parse.wac declares — a gutted constant looks exactly like this`,
      );
    }
    OBSERVED.push({ shape: shapeOf(b[i].message), code: a[i].code, where: JSON.stringify(source) });
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

Deno.test("parse errors: a keyword where a name belongs", () => {
  // The reference gained `declName`, which consumes a keyword found in a name position so
  // that one mistake yields one error rather than a cascade. Consumption moves every
  // following position, so this is exactly the kind of recovery change that must be
  // ported rather than approximated — `"export export"` in the case list below is what
  // caught it, before these cases existed.
  agreeAll("keyword-as-name", [
    "i32 f(i32 match) { return 1; }",
    "i32 f() { i32 match = 1; }",
    "i32 match() { return 1; }",
    "struct S { i32 match; }",
    "struct match { i32 x; }",
    "enum match { A }",
    "i32 f() { return x.match; }",
    "i32 f() { x.match = 1; }",
    "i32 f() { return S { match: 1 }; }",
    // The guard on the declaration lookahead: these stay expressions.
    "i32 f(f64 x) { i32 y = x as~ i32; return y; }",
    "i32 f(i32 a, i32 b) { return a < b ? 1 : 0; }",
    // Two keywords running together, and a keyword as the *last* thing in the file.
    "export export",
    "i32 f(i32 match",
    "struct S { i32 match",
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

Deno.test("parse errors: a code means one thing, and the codes discriminate", async () => {
  // Runs last, over everything the cases above produced. Two claims, neither of which needs me to guess
  // what each code is *supposed* to mean:
  //
  //   - the same reference message shape never comes back as two different codes;
  //   - every code that comes back is one the source actually declares, which is what catches a constant
  //     gutted to `return 0`: a count of distinct codes cannot, since replacing one value with zero
  //     leaves the count unchanged, and that is how the first version of this let the mutant through;
  //   - the corpus produces at least six distinct codes, so a wholesale collapse fails too.
  if (OBSERVED.length < 50) {
    throw new Error(`only ${OBSERVED.length} errors observed; the cases above must run first`);
  }
  // Against the *recorded* numbering, not the source's current one: scraping the source would move with
  // a mutated constant, which is exactly how this check first let one through.
  const faults = relationFaults(OBSERVED, 6, PARSE_CODE_VALUES);
  if (faults.length > 0) throw new Error(`${faults.length} fault(s):\n  ${faults.join("\n  ")}`);
  const codes = new Set(OBSERVED.map((o) => o.code));
  console.log(`  ${OBSERVED.length} errors, ${new Set(OBSERVED.map((o) => o.shape)).size} distinct ` +
    `reference shapes, ${codes.size} distinct wacc codes`);
});

Deno.test("parse errors: the numbering has not drifted from what is recorded", async () => {
  // The other half: the source's constants must still be the values `errorCodes.ts` records. Together
  // the two mean a code cannot change without one of them failing — the recorded set catches a constant
  // whose value moved, and this catches the record going stale after a deliberate renumber.
  const inSource = await declaredCodes("packages/wacc/src/parse.wac", "perr");
  for (const [code, name] of PARSE_CODE_VALUES) {
    const found = inSource.get(code);
    if (found !== name) {
      throw new Error(`${name} should be ${code}; the source has ${found ?? "nothing"} there`);
    }
  }
  if (inSource.size !== PARSE_CODE_VALUES.size) {
    throw new Error(`${inSource.size} codes in parse.wac, ${PARSE_CODE_VALUES.size} recorded`);
  }
});
