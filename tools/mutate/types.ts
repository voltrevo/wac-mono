// What a mutant is, once it has been located in the source.

/**
 * A hand-written mutation, located by matching text.
 *
 * `find` must occur exactly once in `file` unless `nth` says which occurrence is
 * meant. That requirement is not pedantry: `String.replace` takes the first match, so
 * an ambiguous pattern silently mutates a line other than the one the mutation is
 * named for, and the result looks like a real kill for the wrong reason.
 * `crc32/final-inversion` was doing exactly that — `return crc ^ 0xFFFFFFFF;` appears
 * in both `crc32` and `crc32Bitwise`, and only the first was ever mutated.
 */
export type Curated = {
  name: string;
  file?: string;
  find?: string;
  replace?: string;
  /** 1-based, and required when `find` is not unique. */
  nth?: number;
  edits?: { file: string; find: string; replace: string; nth?: number }[];
  /** Changes only how well it compresses, never correctness. */
  ratioOnly?: boolean;
  /** A no-op control: must survive, or the harness itself is broken. */
  mustSurvive?: boolean;
  /**
   * Why this mutation is provably unobservable, if it is. Set only with evidence —
   * an equivalent mutant is indistinguishable from a coverage gap until you show
   * which one it is. TCE now proves a subset of these automatically; this field is
   * for the ones that need an argument.
   */
  equivalent?: string;
};

/** One edit, as a byte span rather than a pattern, so its location is unambiguous. */
export type Edit = {
  file: string;
  start: number;
  end: number;
  replacement: string;
  /** The text being replaced, kept for the report. */
  was: string;
};

export type Mutant = {
  name: string;
  edits: Edit[];
  /** `curated` was written by hand; `operator` was generated mechanically. */
  origin: "curated" | "operator";
  ratioOnly?: boolean;
  mustSurvive?: boolean;
  equivalent?: string;
};

/** Every package a set of edits touches, for scoping the test run. */
export function packagesOf(m: Mutant): string[] {
  const out = new Set<string>();
  for (const e of m.edits) {
    const parts = e.file.split("/");
    if (parts[0] === "packages" && parts.length > 1) out.add(parts[1]);
  }
  return [...out].sort();
}

/** Apply a mutant's edits to the sources it touches. */
export function applyEdits(sources: Map<string, string>, m: Mutant): Map<string, string> {
  const out = new Map(sources);
  // Right to left, so an earlier edit's offsets stay valid after a later one is applied.
  const byFile = new Map<string, Edit[]>();
  for (const e of m.edits) {
    const list = byFile.get(e.file) ?? [];
    list.push(e);
    byFile.set(e.file, list);
  }
  for (const [file, edits] of byFile) {
    let text = out.get(file);
    if (text === undefined) throw new Error(`${m.name}: no source loaded for ${file}`);
    for (const e of [...edits].sort((a, b) => b.start - a.start)) {
      text = text.slice(0, e.start) + e.replacement + text.slice(e.end);
    }
    out.set(file, text);
  }
  return out;
}
