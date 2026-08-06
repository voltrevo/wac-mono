// Rung 1: the wac lexer against the TypeScript one, token for token.
//
// The oracle is the reference implementation, so there is nothing to assert about
// what a token *should* be — only that both lexers agree. The corpus is every .wac
// file in this repo plus the language tour, which between them cover the whole
// grammar, followed by generated edge cases for the things a corpus of working code
// never contains.
//
// Kind numbering is read out of wacLex.ts's `TokenKind` union at run time rather
// than hardcoded here, so reordering the union breaks this test loudly instead of
// silently comparing the wrong names.

import { wacLex } from "wac/wacLex.ts";
import {
  CODE_DIVERGENCES,
  disagreement,
  LEX_CODES,
  staleDivergence,
  tableFaults,
} from "./errorCodes.ts";
import { wacBind } from "../../../harness/wacBind.ts";
import { loadCorpus } from "./corpus.ts";

const mod = await wacBind("packages/wacc/src/lex.wac");
const lex = mod.lex as (src: Uint8Array) => unknown;

// The wac side returns a struct, which bindgen cannot marshal, so the exports used
// here are the flat accessors.
const tokensOf = mod.lexTokens as (src: Uint8Array) => Int32Array;
const errorsOf = mod.lexErrors as (src: Uint8Array) => Int32Array;
void lex;

const STRIDE = 5;

/** Kind names in declaration order — the numbering the wac side uses. */
async function kindNames(): Promise<string[]> {
  // **Through the import map, not a path relative to this file.** `deno.json` maps `wac/` to the sibling
  // checkout, and a mutation sweep stages the project into a temp directory *and rewrites that mapping to
  // an absolute path* precisely so the staged copy can still find the compiler. A hand-built
  // `../../../../wac/...` ignores all of that and points at `/tmp/wac/...`, which does not exist — so
  // this test failed in every staged run, the sweep reported `BASELINE RED: packages/wacc`, and
  // `packages/wacc` could not be swept at all. It is the package with the most surviving mutants in
  // wac-mono 0005. `import.meta.resolve` asks the map.
  const src = await Deno.readTextFile(new URL(import.meta.resolve("wac/wacLex.ts")));
  const m = src.match(/export type TokenKind =([\s\S]*?)\| "eof";/);
  if (!m) throw new Error("could not find the TokenKind union in wacLex.ts");
  const found = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
  const out: string[] = [];
  for (const k of [...found, "eof"]) if (!out.includes(k)) out.push(k);
  return out;
}

const KINDS = await kindNames();

/** Decode a string literal's raw span the way the reference stores it. */
function unescape(raw: string): string {
  const body = raw.slice(1, raw.endsWith('"') && raw.length > 1 ? -1 : undefined);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") { out += body[i]; continue; }
    const esc = body[++i];
    if (esc === "n") out += "\n";
    else if (esc === "t") out += "\t";
    else if (esc === "r") out += "\r";
    else if (esc === "\\") out += "\\";
    else if (esc === '"') out += '"';
    else if (esc === "0") out += "\0";
    else out += esc ?? "";
  }
  return out;
}

/** Decode a character literal's raw span to the codepoint the reference stores. */
function charValue(raw: string): string {
  const body = raw.slice(1, raw.endsWith("'") && raw.length > 1 ? -1 : undefined);
  if (body.length === 0) return "0";
  if (body[0] === "\\") {
    const esc = body[1];
    const map: Record<string, number> = {
      n: 10, t: 9, r: 13, "\\": 92, '"': 34, "'": 39, "0": 0,
    };
    return String(map[esc] ?? esc?.codePointAt(0) ?? 0);
  }
  return String(body.codePointAt(0)!);
}

type Mismatch = { at: number; field: string; got: string; want: string };

/** Compare both lexers on one source, returning the first few disagreements. */
function compare(source: string): Mismatch[] {
  const bytes = new TextEncoder().encode(source);
  const flat = tokensOf(bytes);
  const ref = wacLex(source).tokens;
  const out: Mismatch[] = [];

  const mine = flat.length / STRIDE;
  if (mine !== ref.length) {
    out.push({ at: -1, field: "count", got: String(mine), want: String(ref.length) });
  }

  for (let i = 0; i < Math.min(mine, ref.length) && out.length < 6; i++) {
    const kind = KINDS[flat[i * STRIDE]];
    const start = flat[i * STRIDE + 1];
    const len = flat[i * STRIDE + 2];
    const line = flat[i * STRIDE + 3];
    const col = flat[i * STRIDE + 4];
    const r = ref[i];

    if (kind !== r.kind) out.push({ at: i, field: "kind", got: kind, want: r.kind });
    if (line !== r.line) out.push({ at: i, field: "line", got: String(line), want: String(r.line) });
    if (col !== r.col) out.push({ at: i, field: "col", got: String(col), want: String(r.col) });

    // Text: a span for most kinds, decoded for the two that store a computed value.
    const raw = new TextDecoder().decode(bytes.subarray(start, start + len));
    let text = raw;
    if (r.kind === "string") text = unescape(raw);
    else if (r.kind === "int" && raw.startsWith("'")) text = charValue(raw);
    else if (r.kind === "eof") text = r.text;   // the reference's eof text is ""
    if (text !== r.text) out.push({ at: i, field: "text", got: JSON.stringify(text), want: JSON.stringify(r.text) });
  }
  return out;
}

function check(name: string, source: string): void {
  const bad = compare(source);
  if (bad.length > 0) {
    const lines = bad.map((m) =>
      `  token ${m.at} ${m.field}: got ${m.got}, reference says ${m.want}`);
    throw new Error(`${name}: ${bad.length} disagreement(s) with the reference lexer\n${lines.join("\n")}`);
  }
}

// ── Corpus ────────────────────────────────────────────────────────────────────

Deno.test("lex: agrees with the reference on every .wac file in the repo", async () => {
  const files = await loadCorpus("lex");
  for (const [name, source] of files) check(name, source);
});

Deno.test("lex: agrees on constructs a working corpus does not contain", () => {
  // Every one of these is either an error case or a token that no committed file
  // happens to use, so the corpus above cannot cover them.
  const cases: [string, string][] = [
    ["empty", ""],
    ["only whitespace", "  \t\r\n  "],
    ["only a line comment", "// nothing else"],
    ["unterminated block comment", "/* never closed"],
    ["nested-looking block comment", "/* /* still one comment */"],
    ["unterminated string", '"open'],
    ["unknown escape", '"a\\qb"'],
    ["every escape", '"\\n\\t\\r\\\\\\"\\0"'],
    ["empty string", '""'],
    ["char literals", "'a' '\\n' '\\'' '\\\\' '0'"],
    ["empty char literal", "''"],
    ["unterminated char literal", "'a"],
    ["char literal too long", "'ab'"],
    ["unexpected character", "$ # `"],
    ["all operators", "+ - * / % = == != < <= > >= && || ! & | ^ ~ << >> >>> " +
      "+= -= *= /= %= &= |= ^= <<= >>= >>>= ++ --"],
    ["all punctuation", "( ) { } [ ] ; : , . ? @"],
    ["cast suffixes", "as as! as~ as@"],
    ["greedy operator runs", ">>>>= <<<= ===== !=== &&& |||"],
    ["numbers", "0 1 42 0x0 0xFF 0xff_ff 1_000 1.5 1.5e10 1.5e+10 1.5e-10 0.0"],
    // An exponent with no decimal point became a float in wac issue 0018, and `1e`/`1electron`
    // must stay an integer followed by an identifier.
    ["bare exponents", "1e9 1E10 2e-3 1_000e3 1e1_0"],
    ["not exponents", "1e 1electron 0x1e5"],
    ["number then dot", "1.foo"],
    ["keywords", "import from export struct const this override if else while for " +
      "do switch case default break continue return trap true false null is not " +
      "as void fn"],
    ["near-keywords", "iff ass forr constx thisx notx fnx _if if_ If IF"],
    ["identifiers", "a _ _a a1 A Z z0_9 __dunder__"],
    ["adjacent tokens", "a+b*c(d)[e]{f};g:h,i.j?k@l"],
    ["no trailing newline", "i32 x = 1;"],
    ["crlf line endings", "i32 a = 1;\r\ni32 b = 2;\r\n"],
    ["tabs for indentation", "\ti32 x = 1;\n\t\ti32 y = 2;"],
    ["non-ascii in a comment", "// héllo → 😀 world\ni32 x = 1;"],
    ["non-ascii in a string", 'string s = "héllo → 😀";'],
    ["non-ascii then token on the same line", 'i32 a = 1; // é\ni32 b = 2;'],
  ];
  for (const [name, source] of cases) check(name, source);
});

Deno.test("lex: error codes and positions line up with the reference", () => {
  // Count, position **and code**. The wac side reports numbers where the reference reports English, so
  // `errorCodes.ts` says which number means which message; a code with no entry — what a constant gutted
  // to `return 0` produces — fails here.
  //
  // Every one of the seven error kinds has a case below, and that is not decoration: a sweep found
  // `errUnterminatedChar` and `errUnknownEscape` surviving because no source here reached them, so the
  // comparison had nothing to compare. A code the cases never produce is a code nothing checks.
  const cases: [string, number][] = [
    ["", 0],
    ['"unterminated', 1],
    ["/* unterminated", 1],
    ['"a\\qb"', 1],
    ["''", 1],
    ["'ab'", 1],
    // errUnterminatedChar and errUnknownEscape, which nothing reached until a sweep said so.
    ["'a", 1],
    ["'", 1],
    ["'\\q'", 1],
    ['"a\\q"', 1],
    ["$", 1],
    ["$ $ $", 3],
    ['i32 x = 1; $ "open', 2],
  ];
  for (const [source, wantCount] of cases) {
    const bytes = new TextEncoder().encode(source);
    const flat = errorsOf(bytes);
    const mine = flat.length / 3;
    const ref = wacLex(source).errors;
    if (mine !== ref.length) {
      throw new Error(`${JSON.stringify(source)}: ${mine} errors, reference says ${ref.length}`);
    }
    if (mine !== wantCount) {
      throw new Error(`${JSON.stringify(source)}: expected ${wantCount} errors, both produced ${mine}`);
    }
    for (let i = 0; i < mine; i++) {
      if (flat[i * 3 + 1] !== ref[i].line || flat[i * 3 + 2] !== ref[i].col) {
        throw new Error(
          `${JSON.stringify(source)}: error ${i} at ${flat[i * 3 + 1]}:${flat[i * 3 + 2]}, ` +
          `reference says ${ref[i].line}:${ref[i].col}`);
      }
      // **And the code, which nothing checked until now.** Position and count were compared and the
      // first field of each triple — the one that says *what went wrong* — was dropped. A mutation
      // sweep put `return 0` in place of every error constant and this test stayed green. wac-mono 0005.
      if (CODE_DIVERGENCES.has(source)) {
        // Recorded as a disagreement about *category*, with the argument in `errorCodes.ts`. Checked the
        // other way instead: if the two have started agreeing, the entry is stale and hiding a real
        // comparison, so it has to be removed rather than left standing.
        if (staleDivergence(source, flat[i * 3], ref[i].message)) {
          throw new Error(
            `${JSON.stringify(source)} is recorded as a divergence but the two now agree — ` +
              `delete the entry in errorCodes.ts`,
          );
        }
        continue;
      }
      const wrong = disagreement(LEX_CODES, flat[i * 3], ref[i].message);
      if (wrong !== null) throw new Error(`${JSON.stringify(source)}: error ${i}: ${wrong}`);
    }
  }
});

Deno.test("lex errors: the code table itself is sound", async () => {
  // The table is hand-written, because the reference has no error kinds to derive from — it interpolates
  // English at each site. So the table gets its own check: no code twice, and every code the source can
  // emit is in it. Without this, a code added to `lex.wac` would be compared against nothing.
  const faults = tableFaults(LEX_CODES);
  if (faults.length > 0) throw new Error(faults.join("; "));
  const declared = new Set(LEX_CODES.map((c) => c.code));
  const inSource = [...(await Deno.readTextFile("packages/wacc/src/lex.wac")).matchAll(
    // `err[A-Z]` rather than `err\w+`: the latter also matches `errorStride()`, which is a layout
    // constant and not a code, and the count check duly reported eight where the table has seven.
    /^export i32 (err[A-Z]\w*)\(\)\s*\{\s*return (\d+);/gm,
  )];
  for (const [, name, code] of inSource) {
    if (!declared.has(Number(code))) {
      throw new Error(`${name} = ${code} is in lex.wac and not in the table, so nothing compares it`);
    }
  }
  if (inSource.length !== LEX_CODES.length) {
    throw new Error(`${inSource.length} codes in lex.wac, ${LEX_CODES.length} in the table`);
  }
});
