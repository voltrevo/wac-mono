// Every runnable program in this repo, found the way `MAP.md` finds them.
//
// One definition of "a program", used by `tools/map.ts` to write the map and by
// `tools/programs.test.ts` to compile them all. Two copies of this regex would drift, and the drift
// would be invisible in the direction that matters: a program the test does not know about is a program
// nothing compiles, which is wac-mono 0079.
//
// A program is a `.wac` file outside a `test/` directory exporting `main` or `page`. That is the whole
// rule — `packages/platform`'s `entry.ts` dispatches on exactly those two names, so anything else is a
// library however it is written.

export type ProgramKind = "cli" | "page";

export type Program = {
  /** Repo-relative, as `MAP.md` prints it. */
  path: string;
  kind: ProgramKind;
  /** The package it belongs to, which is the first path segment under `packages/`. */
  pkg: string;
  /** The opening comment line, which every entry point here has. */
  blurb: string;
};

/** The repo root, from this file's location, so a caller's working directory does not matter. */
export const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory) yield* walk(path);
    else if (e.isFile) yield path;
  }
}

/** The first line of a program's opening comment, trimmed of its slashes. */
export function blurbOf(src: string): string {
  const first = src.split("\n")[0] ?? "";
  return first.startsWith("//") ? first.slice(2).trim() : "";
}

/**
 * Every program, sorted by path.
 *
 * Excludes `test/` deliberately: a wac test file exports `test_*` functions and is run by the harness,
 * not by anybody's command line.
 */
export async function findPrograms(): Promise<Program[]> {
  const out: Program[] = [];
  for await (const entry of Deno.readDir(`${ROOT}/packages`)) {
    if (!entry.isDirectory) continue;
    for await (const path of walk(`${ROOT}/packages/${entry.name}`)) {
      if (!path.endsWith(".wac")) continue;
      const rel = path.slice(ROOT.length + 1);
      if (rel.includes("/test/")) continue;
      const src = await Deno.readTextFile(path);
      const blurb = blurbOf(src);
      if (/^export i32 main\(/m.test(src)) out.push({ path: rel, kind: "cli", pkg: entry.name, blurb });
      if (/^export i32 page\(/m.test(src)) out.push({ path: rel, kind: "page", pkg: entry.name, blurb });
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
