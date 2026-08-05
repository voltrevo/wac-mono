// Content-addressed caching for the two slow things this repo does: compiling a wac program, and
// bundling one into an application.
//
// The suite spends nearly all of its time on work it has already done. `packages/box`'s tests build
// fifteen binaries from the same `box.wac`, differing only in which grants are baked in; the shell's
// differential test builds `sh.wac`; four other files build the same programs again. Every one of
// those ran `wacCompile` over the whole import graph and `deno bundle` twice, from scratch, on every
// run — so a full sequential pass took ten minutes and a single package took thirty seconds, which is
// long enough that nobody runs one package while working on it.
//
// **The key is content, never a timestamp.** An mtime cache is wrong in the direction that costs a
// day: `git checkout` of an older file is a *new* input with an *older* mtime, and a cache that
// believed the timestamp would hand back the newer build and report a pass for code that is not
// there. Everything that can change the output goes into a SHA-256, and anything this file cannot
// hash — a compiler it cannot locate — disables the cache rather than being assumed unchanged.
//
// What goes in, and why each one is not optional:
//
//   - every reachable `.wac` file, by content — the program itself
//   - every `.ts` file of the wac compiler — a compiler fix must not be served a stale wasm, and
//     this is the case that would waste the most time, since the symptom would be "my fix did
//     nothing" (wac issues 0001 and 0008 are the same lesson, one layer up)
//   - the harness and, for an application, `packages/platform`'s host — the bundle *is* that code
//   - `Deno.version.deno` — the bundler's output is the bundler's business
//   - the arguments: entry, grants, target, whether the worker half alone was asked for
//
// Deleting `.cache` is always safe and always correct. It is the whole of the invalidation story.

const CACHE_DIR = ".cache";

/** How many artifacts to keep in a cache directory before the oldest are dropped. */
const KEEP = 120;

const enc = new TextEncoder();

/**
 * SHA-256 of these parts, hex.
 *
 * Length-prefixed rather than joined by a separator, because a separator is a claim about what the
 * inputs cannot contain and these inputs are whole source files. With a NUL, a file holding one
 * makes two different programs hash alike; with a space, `["a b", "c"]` and `["a", "b", "c"]`
 * already do. A length in front of each part cannot be mistaken for the part.
 */
export async function contentKey(parts: string[]): Promise<string> {
  const framed = parts.map((p) => `${p.length}:${p}`).join("");
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(framed));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A `Map` of path to source, flattened in a fixed order so two runs agree. */
export function filesParts(files: Map<string, string>): string[] {
  return [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).flat();
}

/**
 * Where the wac compiler is, from the import map rather than hardcoded.
 *
 * The same derivation `wacVersion.ts` uses, and for the same reason: `deno.json` maps `wac/` to a
 * sibling checkout, so the compiler is wherever the reader put it.
 */
function compilerRoot(): string | null {
  try {
    const url = import.meta.resolve("wac/wacCompile.ts");
    if (!url.startsWith("file://")) return null;
    const path = decodeURIComponent(new URL(url).pathname);
    return path.slice(0, path.lastIndexOf("/"));
  } catch {
    return null;
  }
}

async function hashDir(dir: string, suffix: string): Promise<string[]> {
  const parts: string[] = [];
  const names: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    if (e.isFile && e.name.endsWith(suffix)) names.push(e.name);
  }
  names.sort();
  for (const name of names) {
    parts.push(`${dir}/${name}`, await Deno.readTextFile(`${dir}/${name}`));
  }
  return parts;
}

let compilerParts: string[] | null | undefined;

/**
 * The compiler's own sources, as key material. Null when they cannot be found.
 *
 * Null disables caching in every caller. A compiler that cannot be identified is exactly the case
 * where a stale artifact does the most damage — the developer is editing the compiler — so the
 * unanswerable question is answered with "do not cache" rather than "assume unchanged".
 */
export async function compilerKeyParts(): Promise<string[] | null> {
  if (compilerParts !== undefined) return compilerParts;
  const root = compilerRoot();
  if (root === null) {
    compilerParts = null;
    return null;
  }
  try {
    compilerParts = [Deno.version.deno, ...await hashDir(root, ".ts")];
  } catch {
    compilerParts = null;
  }
  return compilerParts;
}

let harnessParts: string[] | null | undefined;

/** This harness's own sources: it decides what is generated and how. */
export async function harnessKeyParts(): Promise<string[] | null> {
  if (harnessParts !== undefined) return harnessParts;
  const here = decodeURIComponent(new URL(".", import.meta.url).pathname);
  try {
    harnessParts = await hashDir(here.replace(/\/$/, ""), ".ts");
  } catch {
    harnessParts = null;
  }
  return harnessParts;
}

/**
 * A cached artifact, produced on first ask.
 *
 * `produce` is given a path to write and is called only when the key is new. The write is atomic
 * because `--parallel` runs test files in separate processes: two of them can want the same
 * artifact at the same moment, and both will compute identical bytes, so a lost rename race is a
 * duplicate of work rather than a corrupt file. Reading a half-written cache entry is the failure
 * this avoids, and it looks like a syntax error in generated code — see the note in `wacBind.ts`,
 * where it cost an afternoon.
 */
export async function cached(
  kind: string,
  key: string,
  suffix: string,
  produce: (path: string) => Promise<void>,
): Promise<string> {
  const dir = `${CACHE_DIR}/${kind}`;
  const path = `${dir}/${key}${suffix}`;
  try {
    await Deno.stat(path);
    // Touched so that pruning drops what is genuinely unused rather than what was built first.
    await Deno.utime(path, new Date(), new Date()).catch(() => {});
    return path;
  } catch {
    // Not there yet.
  }
  await Deno.mkdir(dir, { recursive: true });
  const tmp = `${path}.${crypto.randomUUID()}.tmp`;
  await produce(tmp);
  try {
    await Deno.rename(tmp, path);
  } catch {
    // Someone else won. Their bytes are ours, since the key is the content of every input.
    await Deno.remove(tmp).catch(() => {});
  }
  await prune(dir);
  return path;
}

/**
 * Keep the cache from growing without bound.
 *
 * Cheap and approximate on purpose: it runs only when an entry was actually built, and a directory
 * under the limit costs one `readDir`. This container filled its disk once already — for an unrelated
 * reason, a `finally` that never ran — and an unbounded cache of half-megabyte binaries is the obvious
 * way to do it again on purpose.
 *
 * Stale *temp* files are dropped here too. A run killed between producing one and renaming it leaves it
 * behind by definition, so nothing else can: an interrupted process has no `finally` that runs.
 */
async function prune(dir: string): Promise<void> {
  const entries: { path: string; at: number }[] = [];
  const now = Date.now();
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile) continue;
      const st = await Deno.stat(`${dir}/${e.name}`).catch(() => null);
      if (st === null) continue;
      const at = st.mtime?.getTime() ?? 0;
      if (e.name.endsWith(".tmp")) {
        // A build that was *interrupted* between producing its temp file and renaming it cannot clean
        // up after itself — a killed test run, a cancelled suite — so 184 of these had accumulated
        // here. Ten minutes is far longer than any build takes and far shorter than a session, so a
        // live one is never touched.
        if (now - at > 600_000) await Deno.remove(`${dir}/${e.name}`).catch(() => {});
        continue;
      }
      entries.push({ path: `${dir}/${e.name}`, at });
    }
  } catch {
    return;
  }
  if (entries.length <= KEEP) return;
  entries.sort((a, b) => a.at - b.at);
  for (const e of entries.slice(0, entries.length - KEEP)) {
    await Deno.remove(e.path).catch(() => {});
  }
}
