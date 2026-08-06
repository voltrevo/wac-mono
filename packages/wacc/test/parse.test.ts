// Rung 2: the wac parser against the TypeScript one, node for node.
//
// Neither side's AST is comparable to the other's directly — one is an object graph
// of string-bearing nodes, the other sum types holding token indices — so both are
// projected onto the canonical text form defined in `src/print.wac`. This file is the
// reference half of that projection. It is deliberately dumb: no cleverness, no
// shared helpers with the wac side, so an agreement means both implementations
// independently arrived at the same tree rather than that one derived from the other.
//
// Positions are included in the comparison. They are part of what a parser owes its
// caller, and rung 3 compares diagnostics by position, so a divergence is much
// cheaper to find here.

import { wacLex } from "wac/wacLex.ts";
import { wacParse } from "wac/wacParse.ts";
import { wacBind } from "../../../harness/wacBind.ts";
import { loadCorpus } from "./corpus.ts";

const mod = await wacBind("packages/wacc/src/api.wac");
const dump = mod.dump as (src: Uint8Array) => string;

// The reference's AST types are structural; typing this printer against them exactly
// would mean importing a dozen unexported types, so it walks with narrow local casts.
// deno-lint-ignore-file no-explicit-any

function pos(n: any): string {
  return `@${n.line}:${n.col}`;
}

/** Escape one byte the way `Pr.escByte` does. */
function escapeStr(value: string): string {
  let out = '"';
  for (const ch of value) {
    const c = ch.codePointAt(0)!;
    if (ch === "\\" || ch === '"') out += "\\" + ch;
    else if (c < 32 || c === 127) out += "\\x" + c.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out + '"';
}

function ty(t: any): string {
  switch (t.kind) {
    case "prim":     return `(prim${pos(t)} ${t.name})`;
    // The argument list is always printed, empty or not: a shape that disappears when empty would let
    // the two implementations agree by both leaving `Vec<i32>`'s arguments out.
    case "struct":
      return `(named${pos(t)} ${t.name} (${(t.typeArgs ?? []).map(ty).join(" ")}))`;
    case "array":    return `(arr${pos(t)} ${ty(t.elem)})`;
    case "nullable": return `(nullable${pos(t)} ${ty(t.inner)})`;
    case "funcref":
      return `(funcref${pos(t)} ${ty(t.ret)} (${t.params.map(ty).join(" ")}))`;
  }
  throw new Error(`unknown type kind ${t.kind}`);
}

/** ` <T U>` after a declaration's name, and ` <>` when it has none. */
function typeParams(ps: string[] | undefined): string {
  return ` <${(ps ?? []).join(" ")}>`;
}

function exprList(items: any[]): string {
  return ` (${items.map(expr).join(" ")})`;
}

function expr(e: any): string {
  switch (e.kind) {
    case "int":    return `(int${pos(e)} ${e.value})`;
    case "float":  return `(float${pos(e)} ${e.value})`;
    case "string": return `(str${pos(e)} ${escapeStr(e.value)})`;
    case "bool":   return `(bool${pos(e)} ${e.value ? "true" : "false"})`;
    case "null":   return `(null${pos(e)})`;
    case "ident":  return `(ident${pos(e)} ${e.name})`;
    case "unary":  return `(unary${pos(e)} ${e.op} ${expr(e.expr)})`;
    case "binary": return `(binary${pos(e)} ${e.op} ${expr(e.left)} ${expr(e.right)})`;
    case "cast":   return `(cast${pos(e)} ${e.op} ${expr(e.expr)} ${ty(e.type)})`;
    case "is": {
      // The right side is a type, the literal string "null", or an expression. Types
      // and expressions share no tag names in this form, so they need no marker.
      const neg = e.not ? "not" : "plain";
      const TYPES = ["prim", "struct", "array", "nullable", "funcref"];
      const rhs = e.rhs === "null"
        ? "null"
        : TYPES.includes(e.rhs.kind) ? ty(e.rhs) : expr(e.rhs);
      return `(is${pos(e)} ${neg} ${expr(e.expr)} ${rhs})`;
    }
    case "matchExpr": {
      // An arm has a value where the statement form's has a body. Same arm syntax, different
      // position — which is how the language reads it too.
      const arms = e.arms.map((a: any) => {
        const name = a.variant === null ? "else" : a.variant;
        return `(arm ${name} (${a.bindings.join(" ")}) ${expr(a.value)})`;
      }).join(" ");
      return `(matchexpr${pos(e)} ${expr(e.subject)} (${arms}))`;
    }
    case "ternary":
      return `(ternary${pos(e)} ${expr(e.cond)} ${expr(e.then)} ${expr(e.else_)})`;
    case "call":   return `(call${pos(e)} ${expr(e.callee)}${exprList(e.args)})`;
    case "index":  return `(index${pos(e)} ${expr(e.expr)} ${expr(e.idx)})`;
    case "field":  return `(member${pos(e)} ${expr(e.expr)} ${e.name})`;
    case "unwrap": return `(unwrap${pos(e)} ${expr(e.expr)})`;
    case "construct": {
      const named = (e.named ?? [])
        .map((n: any) => `(${n.name} ${expr(n.val)})`).join(" ");
      return `(construct${pos(e)} ${ty(e.ctype)}${exprList(e.args ?? [])} (${named}))`;
    }
    case "incr-expr":
      return `(incr${pos(e)} ${e.op} ${e.prefix ? "pre" : "post"} ${lvalue(e.lval)})`;
    case "arrNew": {
      const size = e.size === null ? "-" : expr(e.size);
      const fill = e.fill === undefined || e.fill === null ? "-" : expr(e.fill);
      return `(arrnew${pos(e)} ${ty(e.elem)} ${size} ${fill}${exprList(e.fixed ?? [])})`;
    }
  }
  throw new Error(`unknown expr kind ${e.kind}`);
}

function lvalue(lv: any): string {
  switch (lv.kind) {
    case "lv-ident":  return `(lv-ident${pos(lv)} ${lv.name})`;
    case "lv-field":  return `(lv-field${pos(lv)} ${lvalue(lv.base)} ${lv.field})`;
    case "lv-index":  return `(lv-index${pos(lv)} ${lvalue(lv.base)} ${expr(lv.idx)})`;
    case "lv-unwrap": return `(lv-unwrap${pos(lv)} ${lvalue(lv.base)})`;
  }
  throw new Error(`unknown lvalue kind ${lv.kind}`);
}

function stmtList(items: any[]): string {
  return ` (${items.map(stmt).join(" ")})`;
}

/**
 * The reference's else branch, flattened to a statement list.
 *
 * It models `else if` as its own node kind; the wac AST models it as an else body
 * containing a single `if`, which is what it means. Normalising here rather than in
 * wac keeps the AST free of a case that exists only to mirror the reference.
 */
function elseStmts(els: any): any[] {
  if (els === null || els === undefined) return [];
  if (els.kind === "else-if") return [els.stmt];
  return els.block.stmts;
}

function stmt(s: any): string {
  switch (s.kind) {
    case "var":
      return `(var${pos(s)} ${s.isConst ? "const" : "let"} ${ty(s.type)} ${s.name} ${expr(s.init)})`;
    case "assign":
      return `(assign${pos(s)} ${s.op} ${lvalue(s.lval)} ${expr(s.rhs)})`;
    case "incr":
      return `(incr-stmt${pos(s)} ${s.op} ${lvalue(s.lval)})`;
    case "if":
      return `(if${pos(s)} ${expr(s.cond)}${stmtList(s.then.stmts)}${stmtList(elseStmts(s.els))})`;
    case "while":
      return `(while${pos(s)} ${expr(s.cond)}${stmtList(s.body.stmts)})`;
    case "for": {
      const init = s.init === null ? "-" : stmt(s.init);
      const cond = s.cond === null ? "-" : expr(s.cond);
      const upd  = s.update === null ? "-" : stmt(s.update);
      return `(for${pos(s)} ${init} ${cond} ${upd}${stmtList(s.body.stmts)})`;
    }
    case "dowhile":
      return `(dowhile${pos(s)}${stmtList(s.body.stmts)} ${expr(s.cond)})`;
    case "switch": {
      const cases = s.cases.map((c: any) => {
        const v = c.value === "default" ? "default" : expr(c.value);
        return `(case ${v}${stmtList(c.body)})`;
      }).join(" ");
      return `(switch${pos(s)} ${expr(s.expr)} (${cases}))`;
    }
    case "match": {
      const arms = s.arms.map((a: any) => {
        const name = a.variant === null ? "else" : a.variant;
        return `(arm ${name} (${a.bindings.join(" ")})${stmtList(a.body)})`;
      }).join(" ");
      return `(match${pos(s)} ${expr(s.subject)} (${arms}))`;
    }
    case "return":   return `(return${pos(s)} ${s.value === null ? "-" : expr(s.value)})`;
    case "break":    return `(break${pos(s)})`;
    case "continue": return `(continue${pos(s)})`;
    case "trap":     return `(trap${pos(s)})`;
    case "block":    return `(block${pos(s)}${stmtList(s.block.stmts)})`;
    case "expr":     return `(expr${pos(s)} ${expr(s.expr)})`;
  }
  throw new Error(`unknown stmt kind ${s.kind}`);
}

function params(ps: any[]): string {
  return ` (${ps.map((p) =>
    `(${p.isConst ? "const" : "mut"} ${p.name} ${ty(p.type)})`).join(" ")})`;
}

function decl(d: any): string {
  switch (d.tag) {
    case "import": {
      const items = d.items.map((i: any) => `(${i.name} ${i.alias})`).join(" ");
      // `-` for an ordinary path import, the provider's name for `from core`. Both sides render it,
      // so the corpus compares it rather than agreeing about a field neither one shows.
      return `(import${pos(d)} ${escapeStr(d.path)} ${d.prefix ?? "-"} (${items}))`;
    }
    case "func":
      return `(func${pos(d)} ${d.exported ? "export" : "local"} ${d.name}` +
        `${typeParams(d.typeParams)} ` +
        `${ty(d.returnType)}${params(d.params)}${stmtList(d.body.stmts)})`;
    case "struct": {
      const fields = d.fields.map((f: any) =>
        `(field ${f.isConst ? "const" : "mut"} ${f.name} ${ty(f.type)})`).join(" ");
      const methods = d.methods.map((m: any) => {
        const recv = m.hasThis ? (m.thisConst ? "constthis" : "this") : "static";
        return `(method ${m.name} ${m.isOverride ? "override" : "plain"} ${recv} ` +
          `${ty(m.returnType)}${params(m.params)}${stmtList(m.body.stmts)})`;
      }).join(" ");
      return `(struct${pos(d)} ${d.exported ? "export" : "local"} ` +
        `${d.isConst ? "const" : "mut"} ${d.name}${typeParams(d.typeParams)} ${d.parent ?? "-"} ` +
        `(${fields}) (${methods}))`;
    }
    case "enum": {
      const variants = d.variants.map((v: any) =>
        `(variant ${v.name}${params(v.fields)})`).join(" ");
      // An enum's methods are held by both ASTs and printed by neither: they are compared through rung
      // 3's diagnostics, and printing them here would only test this file against itself.
      return `(enum${pos(d)} ${d.exported ? "export" : "local"} ${d.name}` +
        `${typeParams(d.typeParams)} (${variants}))`;
    }
    case "const":
      return `(const${pos(d)} ${d.exported ? "export" : "local"} ${d.name} ` +
        `${ty(d.type)} ${expr(d.init)})`;
  }
  throw new Error(`unknown decl tag ${d.tag}`);
}

function referenceDump(source: string): string {
  const { tokens } = wacLex(source);
  const { program } = wacParse(tokens, "main.wac");
  const body = program.items.map((d: any) => `\n  ${decl(d)}`).join("");
  return `(program${body})\n`;
}

/** The first line on which the two dumps differ, with a little context. */
function firstDifference(mine: string, ref: string): string | null {
  if (mine === ref) return null;
  const a = mine.split("\n");
  const b = ref.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    // Narrow to the first differing character so a long declaration is readable.
    const x = a[i] ?? "";
    const y = b[i] ?? "";
    let j = 0;
    while (j < x.length && j < y.length && x[j] === y[j]) j++;
    const from = Math.max(0, j - 40);
    return `line ${i + 1}, column ${j + 1}:\n` +
      `  mine: ...${x.slice(from, j + 60)}\n` +
      `  ref:  ...${y.slice(from, j + 60)}`;
  }
  return "the dumps differ only in trailing content";
}

function check(name: string, source: string): void {
  const mine = dump(new TextEncoder().encode(source));
  const ref = referenceDump(source);
  const diff = firstDifference(mine, ref);
  if (diff) throw new Error(`${name}: parser disagrees with the reference\n${diff}`);
}

// ── Corpus ────────────────────────────────────────────────────────────────────

Deno.test("parse: agrees with the reference on every .wac file in the repo", async () => {
  const files = await loadCorpus("parse");
  let failures = 0;
  const messages: string[] = [];
  for (const [name, source] of files) {
    try {
      check(name, source);
    } catch (e) {
      failures++;
      if (messages.length < 3) messages.push(String((e as Error).message));
    }
  }
  if (failures > 0) {
    throw new Error(`${failures} of ${files.length} files disagree\n\n${messages.join("\n\n")}`);
  }
});

Deno.test("parse: agrees on constructs a working corpus does not contain", () => {
  const cases: [string, string][] = [
    ["empty file", ""],
    ["only a comment", "// nothing\n"],
    ["every precedence level in one expression",
      `i32 f(i32 a, i32 b) { return a || b && a | b ^ a & b == a < b << a + b * a as i32; }`],
    ["ternary chained right", `i32 f(bool a) { return a ? 1 : a ? 2 : 3; }`],
    ["is with a nullable type", `bool f(anyref x) { return x is i32[]?; }`],
    ["an anyref array, constructed", `anyref[] f() { return anyref[3](); }`],
    ["an array of nullable primitives", `i32?[] f() { return i32?[3](); }`],
    ["a trailing comma in a type-argument list",
      `struct Vec<T> { T[] items; } i32 f(Vec<i32,> v) { return 0; }`],
    // The comma is the whole case. Without it the variant loop stops because there is no comma to eat,
    // and the method parses by accident; with it, the only thing that ends the variant list is
    // recognising that what comes next declares a method. `Option<T>` in `packages/std` is written the
    // second way, and nothing here reached that path.
    ["an enum whose variants end in a comma, then a method",
      `enum E { A(i32 v), B,\n  i32 val(const this) { return match (this) { case A(v): v, case B: 0 }; }\n}\n` +
      `i32 f(E e) { return e.val(); }`],
    ["is against a type then ternary", `i32 f(anyref x) { return x is i32 ? 1 : 0; }`],
    ["is not null", `bool f(i32[]? x) { return x is not null; }`],
    ["unary chains", `i32 f(i32 a) { return - - !~a; }`],
    ["prefix and postfix increment", `i32 f(i32 a) { i32 b = ++a; return b + a++; }`],
    ["increment as an expression, not a statement", `i32 f(i32 a) { i32 b = a++ * 2; return b; }`],
    ["nested index and field", `i32 f(i32[][] g) { return g[0][1]; }`],
    ["unwrap then field", `struct S { i32 v; } i32 f(S? s) { return s!.v; }`],
    ["array of nullable, nullable array", `i32[]? f(i32?[] a) { return null; }`],
    ["sized and fixed array construction",
      `i32[] f(i32 n) { i32[] a = i32[n](); i32[] b = i32[](1, 2, 3); return a; }`],
    ["nested element type in construction", `i32[][] f() { return i32[][3](); }`],
    ["nullable element type in construction",
      `struct S { i32 v; } S?[] f() { return S?[4](); }`],
    ["funcref type and array of funcrefs",
      `i32 sq(i32 x) { return x * x; }\n` +
      `i32 f() { fn[i32(i32)] g = sq; fn[i32(i32)][] gs = fn[i32(i32)][](sq); return g(2); }`],
    ["named struct construction",
      `struct P { i32 x; i32 y; } P f() { return P { x: 1, y: 2 }; }`],
    ["named construction with a trailing comma",
      `struct P { i32 x; i32 y; } P f() { return P { x: 1, y: 2, }; }`],
    ["static method call and method reference",
      `struct S { i32 v; S make() { return S(1); } i32 get(const this) { return this.v; } }\n` +
      `i32 f() { S s = S.make(); return s.get(); }`],
    ["trailing commas in a call and a param list",
      `i32 g(i32 a, i32 b,) { return a; } i32 f() { return g(1, 2,); }`],
    ["for with every clause empty", `void f() { for (;;) { break; } }`],
    ["for with a compound-assign update", `void f() { for (i32 i = 0; i < 3; i += 2) { } }`],
    ["for with an assignment init, not a declaration",
      `void f() { i32 i = 0; for (i = 0; i < 3; i++) { } }`],
    ["do-while", `void f() { i32 i = 0; do { i++; } while (i < 3); }`],
    ["switch with a bare-statement case body",
      `i32 f(i32 x) { switch (x) { case 1: return 1; case 2: return 2; default: return 0; } }`],
    ["switch with brace-wrapped case bodies",
      `i32 f(i32 x) { switch (x) { case 1: { return 1; } default: { return 0; } } }`],
    ["else if chain",
      `i32 f(i32 x) { if (x == 1) { return 1; } else if (x == 2) { return 2; } else { return 0; } }`],
    ["nested blocks as statements", `void f() { { { i32 x = 1; } } }`],
    ["enum with and without payloads",
      `enum E { A, B(i32 v), C(i32 a, f64 b), } i32 f(E e) { match (e) { case A: return 0; case B(v): return v; case C(a, b): return a; } }`],
    ["match with an else arm and a discard",
      `enum E { A(i32 v), B } i32 f(E e) { match (e) { case A(_): return 1; else: return 0; } }`],
    ["match on a non-variable subject",
      `enum E { A, B } i32 f(E[] es) { match (es[0]) { case A: return 1; case B: return 0; } }`],
    // ── Generics ─────────────────────────────────────────────────────────────
    //
    // The corpus has twenty-five files that use these and none that use the awkward shapes: a triple
    // close, a funcref inside a type argument, a comparison that must *not* be read as one. Both of
    // the parser's generic lookaheads have had bugs in the reference, and these are those bugs.
    ["generic struct and a use of it",
      `struct Vec<T> { T[] items; i32 n; } i32 f(Vec<i32> v) { return v.n; }`],
    ["generic function",
      `T max<T>(T a, T b) { return a; } i32 f() { return max(1, 2); }`],
    ["generic enum with methods",
      `enum Option<T> { None, Some(T v) bool isSome(const this) { return match (this) { case Some(v): true, else: false }; } }`],
    ["two type parameters and a nested argument",
      `struct Map<K, V> { K[] keys; } i32 f(Map<string, Vec<i32>> m) { return 0; }`],
    ["a nested close that the lexer munched into one token",
      `struct Vec<T> { T[] items; } i32 f(Vec<Vec<i32>> v) { return 0; }`],
    ["a triple close", `struct V<T> { T[] i; } i32 f(V<V<V<i32>>> v) { return 0; }`],
    ["a funcref inside a type argument",
      `struct Box<T> { T v; } i32 f(Box<fn[i32(i32)]> b) { return 0; }`],
    ["a generic declared and constructed",
      `struct Vec<T> { i32 n; Vec<T> create() { return Vec<T>(0); } }`],
    ["an array of nullable instantiations",
      `struct E<K, V> { K k; } E<i32, i32>?[] f() { return E<i32, i32>?[8](); }`],
    ["a generic element type in a sized construction",
      `struct Vec<T> { i32 n; } Vec<i32>[] f() { return Vec<i32>[2](fill: Vec<i32>(0)); }`],
    ["a comparison that is not a type argument list", `bool f(i32 a, i32 b) { return a < b; }`],
    ["a comparison chain that could look like one",
      `bool f(i32 a, i32 b, i32 c) { return (a < b) == (b > c); }`],
    ["a shift that is not a close", `i32 f(i32 a) { return a >> 2; }`],
    ["a generic local declaration",
      `struct Vec<T> { i32 n; } i32 f() { Vec<i32> v = Vec<i32>(0); return v.n; }`],
    ["a generic static call",
      `struct Vec<T> { i32 n; Vec<T> create() { return Vec<T>(0); } } i32 f() { return Vec<i32>.create().n; }`],
    // ── match as an expression ───────────────────────────────────────────────
    ["match in expression position",
      `enum E { A, B(i32 v) } i32 f(E e) { return match (e) { case A: 0, case B(v): v }; }`],
    ["match expression with an else arm and a trailing comma",
      `enum E { A, B } i32 f(E e) { return match (e) { case A: 1, else: 0, }; }`],
    ["match expression nested in one of its own arms",
      `enum E { A, B } i32 f(E e) { return match (e) { case A: match (e) { case A: 1, else: 2 }, else: 0 }; }`],
    ["match expression as an initialiser",
      `enum E { A, B } i32 f(E e) { i32 x = match (e) { case A: 1, else: 2 }; return x; }`],
    ["match statement and match expression in one function",
      `enum E { A, B } i32 f(E e) { match (e) { case A: { return 1; } case B: { } } return match (e) { case A: 1, else: 0 }; }`],
    ["exported and const struct with a parent",
      `struct Base { i32 a; } export const struct Derived : Base { i32 b; }`],
    ["struct with override and const this",
      `struct Base { i32 v; i32 get(const this) { return this.v; } }\n` +
      `struct Sub : Base { override i32 get(const this) { return 0; } }`],
    ["struct with a static method and a const field",
      `struct S { const i32 v; S make() { return S(1); } }`],
    ["import with an alias and a trailing comma",
      `import { a as b, c, } from "./m.wac";\ni32 f() { return c(); }`],
    ["top-level const", `const i32 N = 42; i32 f() { return N; }`],
    ["exported top-level const", `export const f64 PI = 3.14; f64 f() { return PI; }`],
    ["char literals as ints", `i32 f() { return 'a' + '\\n' + '\\\\' + '\\''; }`],
    ["non-ascii char literal", `i32 f() { return 'é'; }`],
    ["string with every escape", `string f() { return "\\n\\t\\r\\\\\\"\\0"; }`],
    ["string with non-ascii", `string f() { return "héllo → 😀"; }`],
    ["hex and underscored literals", `i32 f() { return 0xFF + 0xff_ff + 1_000; }`],
    ["float forms", `f64 f() { return 1.5 + 1.5e10 + 1.5e+10 + 1.5e-10 + 0.0; }`],
    ["all four cast operators",
      `i32 f(anyref x, f64 y) { return (y as! i32) + (x as~ i31ref as i32) + (y as i32); }`],
    ["this as an lvalue root",
      `struct S { i32 v; void set(this, i32 n) { this.v = n; } }`],
    ["fixed literal with a named element type",
      `struct S { i32 v; } S[] f() { return S[](S(1), S(2)); }`],
    ["empty literal with a named element type",
      `struct S { i32 v; } S[] f() { return S[](); }`],
    ["sized array with a fill value",
      `struct S { i32 v; } S[] f(i32 n) { return S[n](fill: S(1)); }`],
    ["fill value that is itself a construction",
      `struct S { i32 v; } S[][] f(i32 n) { return S[][n](fill: S[](S(2))); }`],
    ["const parameters",
      `struct P { i32 v; } i32 peek(const P p, i32 n) { return p.v + n; }`],
    ["const parameter in a method",
      `struct P { i32 v; }\nstruct S { i32 n; i32 m(const this, const P p) { return p.v; } }`],
    ["f32 literal by context", `f32 f() { f32 x = 1.5; return x; }`],
    ["compound assignment through an index and a field",
      `struct S { i32 v; } void f(S[] a) { a[0].v += 1; a[0].v >>>= 2; }`],
  ];
  for (const [name, source] of cases) check(name, source);
});
