// Every wac name a README quotes exists, and every signature it prints is the real one.
//
//   deno test -A tools/docSignatures.test.ts
//
// ## Why
//
// A README is the only description of a package most readers will get, and nothing checked that
// its claims about the code were still true. Two were not. `packages/gzip` printed
//
//     export i32 gunzipStream(fn[u8[]()] read, fn[bool(u8[])] write)
//
// which stopped being the signature the day `Read` replaced `u8[]` — and that replacement is the
// whole point of `Read`, since an empty `u8[]` cannot say whether the input finished or failed. The
// same README then named a `gzipBytes` that has never existed. Both were found by eye, which is not
// a method.
//
// ## The two checks, and why not a third
//
// **Signatures** in ```wac fences: an `export` line must match a declaration, parameter types
// included. Precise — there is nothing to argue about and no allowlist.
//
// **Call-shaped references** in prose: `` `name(…)` `` claims something callable exists. Also
// precise once the declaration set includes struct *fields*, because a capability is a funcref
// field rather than a function, and `outputError()` is a real thing spelled that way.
//
// A third was measured and rejected: bare backticked identifiers. 249 of them resolve to nothing,
// and nearly all are prose — `stored`, `mainnet`, `root`. A guard that cries wolf gets ignored and
// then deleted, which is the note `tools/map.ts` already carries about its own `--check`.
//
// External vocabulary is listed below rather than pattern-matched away. A README that says
// `Number(s)` is naming JavaScript's, and one that says `is_valid_merkle_branch(...)` is naming the
// consensus spec's. Writing them down is what makes the rest of the check strict.
//
// Declarations come from the parser rather than a regex, for the reason `harness/wacFiles.ts`
// gives: a specifier — or here a signature — inside a comment or a string is not a declaration, and
// a regex cannot tell.

import { CORE } from "wac/wacCore.ts";
import { wacLex } from "wac/wacLex.ts";
import { wacParse } from "wac/wacParse.ts";
import type { Program, WacType } from "wac/wacParse.ts";

/** Names that belong to something other than this repo, so a README may say them freely. */
const FOREIGN = new Set([
  // JavaScript and the host
  "Number", "String", "Buffer.from", "Date.UTC", "wacCompile", "DecompressionStream",
  // Mathematics and cryptography, written the way the papers write it
  "e", "E", "EXP", "MAC", "O", "sqrt",
  // Ethereum's consensus and execution specs
  "hash_tree_root", "is_valid_merkle_branch", "is_valid_normalized_merkle_branch",
  "get_subtree_index", "transfer", "addr",
  // tor's own source and specification
  "get_time_period_length", "MAX",
  // Placeholders in prose: `x(…)` is any capability, `chooser()` any of several
  "x", "chooser", "feed", "cliFeed", "transform", "page",
  // Named because they do NOT exist: an API that was removed, or one that was never built
  "inputError", "torFetch", "XList",
  // Written by a *reader*, in an example of what their own program exports — `page` is an
  // application's browser entry point and `test_…` is a wac-written test, so neither is ours.
  "page", "test_crc32_of_hello_world",
]);

type Decls = {
  /** Every name a wac declaration introduces: functions, types, variants, fields, methods. */
  names: Set<string>;
  /** Exported function signatures, rendered the way a README would print one. */
  signatures: Map<string, string>;
};

function typeStr(t: WacType): string {
  switch (t.kind) {
    case "prim": return t.name;
    case "struct": return t.typeArgs?.length ? `${t.name}<${t.typeArgs.map(typeStr).join(", ")}>` : t.name;
    case "array": return `${typeStr(t.elem)}[]`;
    case "nullable": return `${typeStr(t.inner)}?`;
    case "funcref": return `fn[${typeStr(t.ret)}(${t.params.map(typeStr).join(", ")})]`;
  }
}

function collect(program: Program, into: Decls): void {
  for (const item of program.items) {
    if (item.tag === "func") {
      into.names.add(item.name);
      if (item.exported) {
        const params = item.params.map((p) => `${p.isConst ? "const " : ""}${typeStr(p.type)} ${p.name}`);
        into.signatures.set(item.name, `export ${typeStr(item.returnType)} ${item.name}(${params.join(", ")})`);
      }
    } else if (item.tag === "struct") {
      into.names.add(item.name);
      for (const f of item.fields) into.names.add(f.name);
      for (const m of item.methods) into.names.add(m.name);
    } else if (item.tag === "enum") {
      into.names.add(item.name);
      for (const v of item.variants) {
        into.names.add(v.name);
        for (const f of v.fields) into.names.add(f.name);
      }
      for (const m of item.methods) into.names.add(m.name);
    } else if (item.tag === "const") {
      into.names.add(item.name);
    }
  }
}

async function declarations(): Promise<Decls> {
  const out: Decls = { names: new Set(), signatures: new Map() };
  const walk = async (dir: string): Promise<void> => {
    for await (const e of Deno.readDir(dir)) {
      const path = `${dir}/${e.name}`;
      if (e.isDirectory) await walk(path);
      else if (e.name.endsWith(".wac")) {
        const { tokens } = wacLex(await Deno.readTextFile(path));
        const { program } = wacParse(tokens, path);
        collect(program, out);
      }
    }
  };
  for await (const pkg of Deno.readDir("packages")) {
    if (!pkg.isDirectory) continue;
    // `src/` only: an example or a test may name something it declares itself, and a README
    // quoting one of those is quoting the example rather than the package.
    try {
      await walk(`packages/${pkg.name}/src`);
    } catch {
      // A package with no src/ contributes nothing.
    }
  }
  // `core` is not in any package — it ships inside the compiler — but `Read`, `Data`, `End` and
  // `Failed` are named by READMEs all over this repo, and they are the most real names here.
  collect(wacParse(wacLex(CORE.source).tokens, CORE.key).program, out);
  return out;
}

/** Every package README, as path and text. */
async function readmes(): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  for await (const pkg of Deno.readDir("packages")) {
    if (!pkg.isDirectory) continue;
    const path = `packages/${pkg.name}/README.md`;
    try {
      out.push({ path, text: await Deno.readTextFile(path) });
    } catch {
      // Not every package has one.
    }
  }
  return out;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

Deno.test("docs: an `export` signature in a README is the signature in the source", async () => {
  const decls = await declarations();
  const wrong: string[] = [];
  for (const { path, text } of await readmes()) {
    for (const fence of text.matchAll(/^```wac\n([\s\S]*?)^```/gm)) {
      for (const m of fence[1].matchAll(/^\s*(export\s+[^\n{;]*?\))\s*[{;]?\s*$/gm)) {
        const written = norm(m[1]);
        const name = written.match(/^export\s+\S+\s+([A-Za-z_]\w*)\s*\(/)?.[1];
        if (name === undefined) continue;             // not a function signature
        if (FOREIGN.has(name)) continue;
        const real = decls.signatures.get(name);
        const line = text.slice(0, text.indexOf(m[1])).split("\n").length;
        if (real === undefined) {
          wrong.push(`${path}:${line}: names \`${name}\`, which no package exports`);
        } else if (norm(real) !== written) {
          wrong.push(`${path}:${line}:\n      says: ${written}\n      is:   ${norm(real)}`);
        }
      }
    }
  }
  if (wrong.length) throw new Error(`${wrong.length} signature(s) a README gets wrong:\n  ${wrong.join("\n  ")}`);
});

Deno.test("docs: a README's `name(…)` names something that exists", async () => {
  const decls = await declarations();
  const missing: string[] = [];
  for (const { path, text } of await readmes()) {
    for (const m of text.matchAll(/`([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\([^`]*\)`/g)) {
      const written = m[1];
      const name = written.split(".").pop()!;
      if (decls.names.has(name) || FOREIGN.has(name) || FOREIGN.has(written)) continue;
      const line = text.slice(0, m.index!).split("\n").length;
      missing.push(`${path}:${line}: \`${written}(…)\` — no declaration, and not in FOREIGN`);
    }
  }
  if (missing.length) {
    throw new Error(
      `${missing.length} reference(s) to something that does not exist:\n  ${missing.join("\n  ")}\n\n` +
        `If the name belongs to another system — JavaScript, a spec, another implementation — add it ` +
        `to FOREIGN in this file with the group comment that says which.`,
    );
  }
});
