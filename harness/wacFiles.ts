// wacFiles — read a .wac entry file and everything it imports, transitively.
//
// wacCompile takes a path -> source map and does no I/O of its own, so someone
// has to walk the import graph. That someone is here rather than in a test, so
// the tests stay about gzip.
//
// The walk lexes rather than pattern-matching the raw text. A regex found import
// specifiers inside comments and string literals too, which meant a file that merely
// *described* an import — `// import { a } from "./m.wac"` in a doc comment — sent
// the walker off to read a file that does not exist, with an error pointing at the
// missing file rather than at the comment. Using the real lexer makes that class of
// mistake impossible instead of merely unlikely.

import { wacLex } from "wac/wacLex.ts";

/** Resolve `spec` relative to the directory of `fromPath`. */
function resolveFrom(fromPath: string, spec: string): string {
  const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : ".";
  const joined = `${dir}/${spec}`;
  // Collapse `a/./b` and `a/b/../c` so the same file is never keyed two ways.
  // An absolute path keeps its leading slash — normalising it away silently turns
  // it into a relative path and the read fails somewhere far from the cause.
  const absolute = joined.startsWith("/");
  const parts: string[] = [];
  for (const part of joined.split("/")) {
    if (part === "." || part === "") continue;
    if (part === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
    else parts.push(part);
  }
  return (absolute ? "/" : "") + parts.join("/");
}

/**
 * The path of every `import ... from "..."` in `src`.
 *
 * Comments and string literals cannot contribute, because the lexer has already
 * classified them. A malformed import contributes nothing and is left for the
 * compiler to report properly.
 */
export function importPaths(src: string): string[] {
  const { tokens } = wacLex(src);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].kind !== "import") continue;
    // Scan to this import's `from`. Stopping at `;` keeps a malformed import from
    // consuming the one after it.
    let j = i + 1;
    // `from` is contextual as of wac 2026-08-02: it lexes as an ordinary identifier so
    // that `slice(a, from, to)` can name its argument, and only an import clause can put
    // one here. Matched by text for that reason.
    const isFrom = (t: { kind: string; text: string } | undefined) =>
      t !== undefined && t.kind === "ident" && t.text === "from";
    while (j < tokens.length && !isFrom(tokens[j]) && tokens[j].kind !== ";") j++;
    if (j < tokens.length && isFrom(tokens[j]) && tokens[j + 1]?.kind === "string") {
      out.push(tokens[j + 1].text);
      i = j + 1;
    }
  }
  return out;
}

export async function wacFiles(entry: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const queue = [entry];

  while (queue.length > 0) {
    const path = queue.shift()!;
    if (files.has(path)) continue;
    const src = await Deno.readTextFile(path);
    files.set(path, src);
    for (const spec of importPaths(src)) {
      queue.push(resolveFrom(path, spec));
    }
  }

  return files;
}
