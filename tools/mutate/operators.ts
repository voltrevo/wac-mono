// Mechanical mutation operators.
//
// Driven by wac's own lexer rather than by regex, which matters for more than tidiness:
// a regex for `<` finds every one inside a comment and a string literal, and mutating
// those produces mutants that are either uncompilable or trivially equivalent. Running
// the real lexer means a token is a token.
//
// The operator set is deliberately small. Mutation testing's value comes from mutants a
// test suite *ought* to catch, and the classic families cover that: a flipped
// comparison, a shifted boundary, a removed guard, a gutted function. Adding operators
// past the point where survivors are still worth reading makes the report longer and
// less useful — Google's finding was that unproductive mutants cost human attention,
// not machine time.

import { wacLex, type Token } from "wac/wacLex.ts";
import type { Edit, Mutant } from "./types.ts";

/** Line/column, as the lexer reports it, to an absolute offset in `source`. */
function offsetIndex(source: string): (line: number, col: number) => number {
  const lineStart: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") lineStart.push(i + 1);
  }
  return (line, col) => lineStart[line - 1] + (col - 1);
}

const edit = (file: string, at: number, was: string, replacement: string): Edit =>
  ({ file, start: at, end: at + was.length, replacement, was });

/**
 * Comparison flips.
 *
 * `<` to `<=` is the off-by-one that boundary tests exist to catch; `<` to `>` is the
 * gross error that any test at all should catch. Both are worth generating: a survivor
 * of the first is a missing boundary case, a survivor of the second means the code is
 * barely tested.
 */
const RELATIONAL: Record<string, string[]> = {
  "<": ["<=", ">"],
  "<=": ["<", ">="],
  ">": [">=", "<"],
  ">=": [">", "<="],
  "==": ["!="],
  "!=": ["=="],
};

/**
 * Which tokens can precede an integer literal that is safe to perturb.
 *
 * A literal in an array-size or index position is as interesting as any other, but a
 * literal that is part of a *declaration* of a fixed-size table — `u8[256]()` paired
 * with a loop bound — produces a mutant that fails to compile or traps everywhere,
 * which is noise rather than signal. There is no cheap syntactic test for that, so
 * this does not try; TCE and the INVALID outcome absorb the ones that do not build.
 */
function isIntLiteral(t: Token): boolean {
  return t.kind === "int";
}

/** Bump an integer literal by one, preserving hex or decimal notation. */
function bumpLiteral(text: string): string | null {
  if (/^0[xX][0-9a-fA-F]+$/.test(text)) {
    const v = BigInt(text);
    return `0x${(v + 1n).toString(16)}`;
  }
  if (/^[0-9]+$/.test(text)) return (BigInt(text) + 1n).toString();
  return null;   // suffixed, float-ish or otherwise not worth guessing at
}

/**
 * Replace a function body with the simplest value of its return type.
 *
 * "Extreme mutation" in the literature. One mutant per function rather than dozens, and
 * a survivor says something blunt and useful: this whole function could return a
 * constant and nothing would notice. It is the cheapest way to get a first signal on a
 * package nobody has measured.
 *
 * Return types that cannot be defaulted generically — a struct, an enum, a generic —
 * are skipped rather than guessed at, since a wrong guess only produces an INVALID.
 */
function defaultValueFor(typeTokens: string[]): string | null {
  const t = typeTokens.join("");
  if (t === "void") return "";
  if (t === "bool") return "false";
  if (t === "string") return '""';
  if (/^(f32|f64)$/.test(t)) return "0.0";
  if (/^([iu](8|16|32|64))$/.test(t)) return "0";
  if (t.endsWith("?")) return "null";
  // `T[]` for a primitive T: an empty array of it.
  const arr = /^([iu](?:8|16|32|64)|f(?:32|64)|bool|string)\[\]$/.exec(t);
  if (arr) return `${arr[1]}[0]()`;
  return null;
}

/**
 * Every top-level function in `source`, as (return-type tokens, body span).
 *
 * Found by walking the token stream and brace-matching, rather than by parsing. The
 * parser would give a cleaner answer, but it reports line/col for declarations and not
 * spans for bodies, so the brace walk is needed either way — and the lexer has already
 * dealt with braces inside strings and comments, which is the only hard part.
 */
function functions(tokens: Token[]): { retType: string[]; name: string; open: number; close: number }[] {
  const out: { retType: string[]; name: string; open: number; close: number }[] = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind === "{") { depth++; continue; }
    if (tokens[i].kind === "}") { depth--; continue; }
    if (depth !== 0) continue;

    // A function at top level is <type> <ident> ( ... ) { — optionally after `export`.
    // Scan back from a `(` that is preceded by an identifier.
    if (tokens[i].kind !== "(") continue;
    const nameTok = tokens[i - 1];
    if (nameTok === undefined || nameTok.kind !== "ident") continue;

    // Collect the return type: the tokens between the start of the declaration and the
    // name. Walk back to `export`, `;`, `}` or the start of file.
    const retType: string[] = [];
    let j = i - 2;
    for (; j >= 0; j--) {
      const k = tokens[j].kind;
      if (k === "export" || k === ";" || k === "}" || k === "{" || k === ",") break;
      retType.unshift(tokens[j].text);
    }
    if (retType.length === 0) continue;

    // Find the matching `)` then require a `{`.
    let paren = 1, p = i + 1;
    for (; p < tokens.length && paren > 0; p++) {
      if (tokens[p].kind === "(") paren++;
      else if (tokens[p].kind === ")") paren--;
    }
    if (p >= tokens.length || tokens[p].kind !== "{") continue;

    let braces = 1, q = p + 1;
    for (; q < tokens.length && braces > 0; q++) {
      if (tokens[q].kind === "{") braces++;
      else if (tokens[q].kind === "}") braces--;
    }
    if (braces !== 0) continue;
    out.push({ retType, name: nameTok.text, open: p, close: q - 1 });
    i = q - 1;
  }
  return out;
}

export type OperatorName = "relational" | "literal" | "guard" | "extreme";
export const ALL_OPERATORS: OperatorName[] = ["relational", "literal", "guard", "extreme"];

/** Generate every mutant the requested operators produce for one file. */
export function generate(
  file: string,
  source: string,
  operators: OperatorName[] = ALL_OPERATORS,
): Mutant[] {
  const { tokens, errors } = wacLex(source);
  if (errors.length > 0) return [];   // not our problem to report; the suite will say so
  const at = offsetIndex(source);
  const out: Mutant[] = [];
  const want = new Set(operators);

  const bodySpans = functions(tokens);

  if (want.has("extreme")) {
    for (const f of bodySpans) {
      const value = defaultValueFor(f.retType);
      if (value === null) continue;
      const open = tokens[f.open], close = tokens[f.close];
      const start = at(open.line, open.col);
      const end = at(close.line, close.col) + 1;
      out.push({
        name: `extreme/${short(file)}/${f.name}`,
        origin: "operator",
        edits: [{
          file,
          start,
          end,
          replacement: value === "" ? "{ }" : `{ return ${value}; }`,
          was: source.slice(start, end),
        }],
      });
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const start = at(t.line, t.col);

    if (want.has("relational")) {
      const alts = RELATIONAL[t.kind];
      if (alts !== undefined && t.text === t.kind) {
        for (const alt of alts) {
          out.push({
            name: `relational/${short(file)}:${t.line}:${t.col}/${t.text}→${alt}`,
            origin: "operator",
            edits: [edit(file, start, t.text, alt)],
          });
        }
      }
    }

    if (want.has("literal") && isIntLiteral(t)) {
      const bumped = bumpLiteral(t.text);
      if (bumped !== null) {
        out.push({
          name: `literal/${short(file)}:${t.line}:${t.col}/${t.text}→${bumped}`,
          origin: "operator",
          edits: [edit(file, start, t.text, bumped)],
        });
      }
    }

    // A `trap` guard removed. `if (bad) { trap; }` becomes `if (bad) { }`, which is
    // what a decoder looks like when someone deletes a validity check — the exact
    // defect this repo's adversarial streams exist to catch.
    //
    // The trailing `;` goes with it. Leaving one behind produces `if (bad) { ; }`, and
    // wac has no empty statement — so the first version of this operator generated 46
    // mutants and all 46 failed to compile, scoring a perfect zero while testing
    // nothing. Exactly the failure the INVALID outcome exists to make visible.
    if (want.has("guard") && t.kind === "trap") {
      const semi = tokens[i + 1];
      const end = semi !== undefined && semi.kind === ";"
        ? at(semi.line, semi.col) + 1
        : start + t.text.length;
      out.push({
        name: `guard/${short(file)}:${t.line}:${t.col}`,
        origin: "operator",
        edits: [{ file, start, end, replacement: "", was: source.slice(start, end) }],
      });
    }
  }
  return out;
}

/** `packages/gzip/src/inflate.wac` → `gzip/inflate`, to keep mutant names readable. */
function short(file: string): string {
  const m = /^packages\/([^/]+)\/(?:src\/)?(.+)\.wac$/.exec(file);
  return m ? `${m[1]}/${m[2]}` : file;
}
