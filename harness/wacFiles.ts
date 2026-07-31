// wacFiles — read a .wac entry file and everything it imports, transitively.
//
// wacCompile takes a path -> source map and does no I/O of its own, so someone
// has to walk the import graph. That someone is here rather than in a test, so
// the tests stay about gzip.

const IMPORT_RE = /\bimport\s*\{[^}]*\}\s*from\s*"([^"]+)"/g;

/** Resolve `spec` relative to the directory of `fromPath`. */
function resolveFrom(fromPath: string, spec: string): string {
  const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : ".";
  const joined = `${dir}/${spec}`;
  // Collapse `a/./b` and `a/b/../c` so the same file is never keyed two ways.
  const parts: string[] = [];
  for (const part of joined.split("/")) {
    if (part === "." || part === "") continue;
    if (part === ".." && parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

export async function wacFiles(entry: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const queue = [entry];

  while (queue.length > 0) {
    const path = queue.shift()!;
    if (files.has(path)) continue;
    const src = await Deno.readTextFile(path);
    files.set(path, src);
    for (const m of src.matchAll(IMPORT_RE)) {
      queue.push(resolveFrom(path, m[1]));
    }
  }

  return files;
}
