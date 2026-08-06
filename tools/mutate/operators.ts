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

/**
 * How many literal mutants to emit per repeated statement shape. See `shapeKey`.
 *
 * Three rather than one because a table's entries are not interchangeable: a binary search notices
 * a corrupted first key and may never reach the five-hundredth. Three spread through the run is
 * cheap insurance against sampling only the part the tests happen to cover.
 */
const LITERAL_PER_SHAPE = 3;

/**
 * A key identifying "the same kind of literal, in the same place, in the same function".
 *
 * The literal operator's cost is dominated by code that repeats one statement: a constant table
 * (`v[0] = 0x...; v[1] = 0x...;` twelve times, or `u8[](0x63, 0x7c, ...)` two hundred and fifty-six
 * times) and unrolled arithmetic (`acc = t3 + 0x1eabfffe * m + carry;` a hundred and forty-four
 * times). Bumping the third entry of a table and bumping the fourth are not two experiments; they
 * are one experiment run twice, and the answer is the same both times because the same assertions
 * decide it.
 *
 * The key is the enclosing function plus the *kinds* of the four tokens either side — the literal's
 * syntactic neighbourhood with names and values erased. Function-scoped on purpose: `map.wac` has
 * three dozen separate constant tables written identically, and collapsing them to one class would
 * throw away thirty-five real questions to save nothing. Two tables in two functions are two
 * classes; twelve words of one table are one.
 *
 * This is the tool's own stated principle applied to itself — see the header comment at the top of
 * this file. Unproductive mutants cost human attention, and a report with 8792 literal mutants of
 * `unicode/src/tables.wac` in it is a report nobody reads.
 */
function shapeKey(tokens: Token[], i: number, fn: string): string {
  const kinds: string[] = [];
  for (let k = i - 4; k <= i + 4; k++) {
    if (k === i) continue;
    kinds.push(tokens[k]?.kind ?? "^");
  }
  return `${fn}|${kinds.join(" ")}`;
}

export type OperatorName = "relational" | "literal" | "guard" | "extreme";
export const ALL_OPERATORS: OperatorName[] = ["relational", "literal", "guard", "extreme"];

/** Generate every mutant the requested operators produce for one file. */
/** What `generate` chose not to emit, so the caller can report it rather than hide it. */
export type GenerateStats = { literalSampled: number; literalSkipped: number; shapes: number };

export function generate(
  file: string,
  source: string,
  operators: OperatorName[] = ALL_OPERATORS,
  stats?: GenerateStats,
  perShape: number = LITERAL_PER_SHAPE,
): Mutant[] {
  const { tokens, errors } = wacLex(source);
  if (errors.length > 0) return [];   // not our problem to report; the suite will say so
  const at = offsetIndex(source);
  const out: Mutant[] = [];
  const want = new Set(operators);

  const bodySpans = functions(tokens);

  // Token index -> the declaration a literal belongs to, for `shapeKey`: the enclosing top-level
  // function, or for module-level code the `const` being initialised.
  //
  // The `const` half is not a detail. The largest tables in the repo are module-level
  // `const u8[] SBOX = u8[](...)` initialisers, which are outside every function span; keying them
  // all to one empty scope put `unicode/src/tables.wac`'s six separate tables into a single class
  // of 8758 members and sampled three literals for the lot. Six tables are six questions.
  const scope = new Array<string>(tokens.length).fill("");
  for (const f of bodySpans) {
    for (let k = f.open; k <= f.close; k++) scope[k] = f.name;
  }
  let lastConst = "";
  for (let k = 0; k < tokens.length; k++) {
    if (scope[k] !== "") continue;                       // inside a function; already named
    if (tokens[k].kind === "const") {
      // `const <type> <ident> = ...` — the identifier is the one just before the `=`.
      for (let j = k + 1; j < tokens.length && tokens[j].kind !== ";"; j++) {
        if (tokens[j].kind === "=") {
          if (tokens[j - 1]?.kind === "ident") lastConst = tokens[j - 1].text;
          break;
        }
      }
    }
    scope[k] = lastConst;
  }
  // Which literal tokens to mutate, decided before emitting any: see `shapeKey`. Two passes are
  // needed because "three spread through the run" cannot be known on the way past the first one,
  // and taking the first three instead would sample a 1459-entry table at entries 0, 1 and 2 —
  // three adjacent ASCII code points, all covered by the same test. The first, middle and last of
  // each class is the cheapest way to reach the parts of a table the tests may never touch.
  const shapeMembers = new Map<string, number[]>();
  if (want.has("literal")) {
    for (let i = 0; i < tokens.length; i++) {
      if (!isIntLiteral(tokens[i]) || bumpLiteral(tokens[i].text) === null) continue;
      const key = shapeKey(tokens, i, scope[i]);
      const list = shapeMembers.get(key);
      if (list === undefined) shapeMembers.set(key, [i]);
      else list.push(i);
    }
  }
  const literalWanted = new Set<number>();
  for (const members of shapeMembers.values()) {
    if (members.length <= perShape) {
      for (const i of members) literalWanted.add(i);
      continue;
    }
    for (let k = 0; k < perShape; k++) {
      // k/(n-1) through the run: 0, middle, end for three.
      literalWanted.add(members[Math.round((k * (members.length - 1)) / (perShape - 1))]);
    }
  }
  if (stats !== undefined) stats.shapes += shapeMembers.size;

  /**
   * Whitespace removed, not collapsed: `{ return 0; }` and `{return 0;}` are the same program, and
   * collapsing runs only equates the spellings that already agree about *where* the spaces are.
   */
  const normalise = (text: string) => text.replace(/\s+/g, "");

  if (want.has("extreme")) {
    for (const f of bodySpans) {
      const value = defaultValueFor(f.retType);
      if (value === null) continue;
      const open = tokens[f.open], close = tokens[f.close];
      const start = at(open.line, open.col);
      const end = at(close.line, close.col) + 1;
      const replacement = value === "" ? "{ }" : `{ return ${value}; }`;
      // A body that *is* the default is not a mutation. `nc`'s `i32 STDIN() { return 0; }` produced
      // `{ return 0; }` — the same program, reported as a surviving mutant because no test can tell one
      // program from itself. The equivalence check compiles both and compares bytes, and did not catch
      // this one; not generating it is cheaper than explaining it, and cannot be wrong: whitespace aside,
      // the two texts are the same. wac-mono 0005.
      if (normalise(source.slice(start, end)) === normalise(replacement)) continue;
      out.push({
        name: `extreme/${short(file)}/${f.name}`,
        origin: "operator",
        edits: [{ file, start, end, replacement, was: source.slice(start, end) }],
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
        // One experiment per repeated shape, not one per occurrence.
        if (!literalWanted.has(i)) {
          if (stats !== undefined) stats.literalSkipped++;
          continue;
        }
        if (stats !== undefined) stats.literalSampled++;
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
