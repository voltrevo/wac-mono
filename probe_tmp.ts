import { wacBind } from "./harness/wacBind.ts";
const cases: [string,string,number|string][] = [
["default-constructed enum field", `
enum E { A(i32 v), B }
struct S { E e; }
export i32 probe() { S s = S(); match (s.e) { case A(v): return v; case B: return 2; } }`, "either 0 or a clear error"],
["default-filled enum array", `
enum E { A(i32 v), B }
export i32 probe() { E[] a = E[2](); match (a[0]) { case A(v): return v; case B: return 2; } }`, "either 0 or a clear error"],
["enum with one variant", `
enum E { Only(i32 v) }
export i32 probe() { match (E.Only(5)) { case Only(v): return v; } }`, 5],
["match with only an else arm", `
enum E { A(i32 v), B }
export i32 probe() { E e = E.A(3); match (e) { else: return 7; } }`, 7],
["is with a variant type", `
enum E { A(i32 v), B }
export i32 probe() { E e = E.A(1); return (e is A ? 10 : 0) + (e is B ? 1 : 0); }`, 10],
["as! downcast to a variant", `
enum E { A(i32 v), B }
export i32 probe() { E e = E.A(4); A c = e as! A; return c.v; }`, 4],
["upcast a variant to its enum", `
enum E { A(i32 v), B }
export i32 probe() { A c = E.A(6); E e = c; match (e) { case A(v): return v; case B: return 0; } }`, 6],
["reference equality of enum values", `
enum E { A(i32 v), B }
export i32 probe() { E x = E.A(1); E y = x; return (x is y ? 1 : 0) + (x is E.A(1) ? 10 : 0); }`, 1],
["enum in a module constant array", `
enum E { A(i32 v), B }
const E[] TABLE = E[](E.A(1), E.B, E.A(3));
export i32 probe() { i32 n = 0; for (i32 i = 0; i < TABLE.len(); i++) { match (TABLE[i]) { case A(v): n += v; case B: n += 100; } } return n; }`, 104],
["packed array payload", `
enum E { Bytes(u8[] b), None }
export i32 probe() { u8[] d = u8[2](); d[0] = 7; d[1] = 9; match (E.Bytes(d)) { case Bytes(b): return b[0] + b[1]; case None: return -1; } }`, 16],
["enum through a funcref parameter", `
enum E { A(i32 v), B }
i32 read(E e) { match (e) { case A(v): return v; case B: return -1; } }
export i32 probe() { fn[i32(E)] f = read; return f(E.A(8)); }`, 8],
["nullable enum array element", `
enum E { A(i32 v), B }
export i32 probe() { E?[] a = E?[2](); a[0] = E.A(5); if (a[0] is null) { return -1; } match (a[0]!) { case A(v): return v; case B: return 0; } }`, 5],
["variant name shadowed by a local", `
enum E { A(i32 v), B }
export i32 probe() { i32 A = 3; E e = E.A(4); match (e) { case A(v): return v + A; case B: return 0; } }`, "7 or a clear error"],
["enum switch subject rejected", `
enum E { A(i32 v), B }
export i32 probe() { E e = E.A(1); switch (e) { case 1: return 1; default: return 0; } }`, "clear error"],
];
let i = 0;
for (const [name, src, want] of cases) {
  i++;
  const path = `packages/wacc/src/tmpp${i}.wac`;
  Deno.writeTextFileSync(path, src);
  try {
    const m = await wacBind(path);
    const got = (m.probe as any)();
    const ok = got === want;
    console.log(`${ok ? "ok   " : "?    "} ${name}: got ${got}, want ${want}`);
  } catch (e) {
    const msg = String(e).split("\n")[0].replace(/^.*?(Error|error): /, "").slice(0, 92);
    console.log(`FAIL  ${name}: ${msg}`);
  }
}
