// Mutation testing for the wac sources.
//
// `deno coverage` measures the TypeScript harness, not the compiled wasm, so
// there is no branch-coverage number for the wac code itself. Mutation testing
// answers the question coverage is a proxy for, and answers it more directly:
// break the implementation on purpose, and see whether the tests notice.
//
// Each mutation is a single deliberate defect — a flipped comparison, an
// off-by-one on a boundary, a reversed bit order, a removed validity check. For
// each one the project is copied to a temp directory, the mutation applied, and
// the suite run there. A mutation that is KILLED (tests fail) is evidence the
// tests cover that behaviour. A mutation that SURVIVES names a behaviour nothing
// checks.
//
// Some survivors are legitimate: mutations that only affect compression ratio,
// not correctness, are marked `ratioOnly` and reported separately, because the
// suite deliberately allows slack there.
//
//   deno run -A tools/mutate.ts            # all mutations
//   deno run -A tools/mutate.ts crc        # only those whose name matches

type Edit = { file: string; find: string; replace: string };

type Mutation = {
  name: string;
  /** One or more simultaneous edits. A single edit may use file/find/replace. */
  file?: string;
  find?: string;
  replace?: string;
  edits?: Edit[];
  /** True if this changes only how well it compresses, never correctness. */
  ratioOnly?: boolean;
  /** A no-op control: must survive, or the harness itself is broken. */
  mustSurvive?: boolean;
  /**
   * Why this mutation is provably unobservable, if it is. Set only with evidence
   * — an equivalent mutant is indistinguishable from a coverage gap until you
   * show which one it is.
   */
  equivalent?: string;
};

function editsOf(m: Mutation): Edit[] {
  if (m.edits) return m.edits;
  return [{ file: m.file!, find: m.find!, replace: m.replace! }];
}

const MUTATIONS: Mutation[] = [
  // ── Control ─────────────────────────────────────────────────────────────────
  // A no-op edit that must SURVIVE. If a staged project failed to build for some
  // unrelated reason, every mutation would report as killed and the whole run
  // would look perfect while proving nothing. This is the check against that:
  // if the control is ever killed, disbelieve the rest of the results.
  {
    name: "control/comment-only-noop",
    file: "src/crc32.wac",
    find: "// CRC-32 as gzip uses it",
    replace: "// CRC-32 as gzip uses it (control mutation: no behaviour change)",
    mustSurvive: true,
  },

  // ── CRC-32 ──────────────────────────────────────────────────────────────────
  {
    name: "crc32/polynomial",
    file: "src/crc32.wac",
    find: "crc ^= 0xEDB88320;",
    replace: "crc ^= 0xEDB88321;",
  },
  {
    name: "crc32/initial-value",
    file: "src/crc32.wac",
    find: "i32 crc = 0xFFFFFFFF;",
    replace: "i32 crc = 0;",
  },
  {
    name: "crc32/final-inversion",
    file: "src/crc32.wac",
    find: "return crc ^ 0xFFFFFFFF;",
    replace: "return crc;",
  },
  {
    name: "crc32/shift-distance",
    file: "src/crc32.wac",
    find: "crc >>>= 1;",
    replace: "crc >>>= 2;",
  },
  {
    name: "crc32/signed-shift",
    file: "src/crc32.wac",
    find: "crc >>>= 1;",
    replace: "crc >>= 1;",
  },

  // ── Bit order ───────────────────────────────────────────────────────────────
  // The classic DEFLATE bug: Huffman codes go MSB-first, everything else
  // LSB-first. Reversing either produces a plausible-looking stream.
  {
    name: "bitwriter/huffman-code-bit-order",
    file: "src/bitwriter.wac",
    find: "for (i32 i = count - 1; i >= 0; i--) {",
    replace: "for (i32 i = 0; i < count; i++) {",
  },
  {
    name: "bitwriter/align-is-noop",
    file: "src/bitwriter.wac",
    find: "if (this.bitCount > 0) {",
    replace: "if (false) {",
  },

  // ── LZ77 boundaries ─────────────────────────────────────────────────────────
  {
    name: "lz77/max-match-258-to-257",
    file: "src/deflate.wac",
    find: "i32 maxMatch()   { return 258; }",
    replace: "i32 maxMatch()   { return 257; }",
    ratioOnly: true,
  },
  {
    name: "lz77/min-match-3-to-4",
    file: "src/deflate.wac",
    find: "i32 minMatch()   { return 3; }",
    replace: "i32 minMatch()   { return 4; }",
    ratioOnly: true,
  },
  {
    name: "lz77/window-off-by-one",
    file: "src/deflate.wac",
    find: "if (dist > maxDist()) {",
    replace: "if (dist > maxDist() + 1) {",
  },
  {
    name: "lz77/chain-limit",
    file: "src/deflate.wac",
    find: "i32 chainLimit() { return 128; }",
    replace: "i32 chainLimit() { return 1; }",
    ratioOnly: true,
  },
  {
    name: "lz77/match-past-end",
    file: "src/deflate.wac",
    find: "while (len < maxMatch() && pos + len < n",
    replace: "while (len < maxMatch() && pos + len <= n",
  },

  // ── Code tables ─────────────────────────────────────────────────────────────
  {
    name: "tables/length-base-entry",
    file: "src/tables.wac",
    find: "131,163,195,227,258),",
    replace: "131,163,195,226,258),",
  },
  {
    name: "tables/distance-base-entry",
    file: "src/tables.wac",
    find: "1025,1537,2049,3073,4097,6145,8193,12289,16385,24577),",
    replace: "1025,1537,2049,3073,4097,6145,8193,12289,16385,24578),",
  },
  {
    name: "tables/length-extra-bits",
    file: "src/tables.wac",
    find: "i32[](0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0),",
    replace: "i32[](0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,1),",
  },
  {
    name: "tables/length-index-off-by-one",
    file: "src/tables.wac",
    find: "while (i > 0 && this.lenBase[i] > len) {",
    replace: "while (i > 0 && this.lenBase[i] >= len) {",
  },

  // ── Huffman construction ────────────────────────────────────────────────────
  {
    name: "huffman/canonical-missing-shift",
    file: "src/huffman.wac",
    find: "code = (code + blCount[bits - 1]) << 1;",
    replace: "code = code + blCount[bits - 1];",
  },
  {
    name: "huffman/length-limit-not-enforced",
    file: "src/huffman.wac",
    find: "if (longest <= maxBits) {",
    replace: "if (true) {",
  },
  {
    name: "huffman/force-two-disabled",
    file: "src/huffman.wac",
    find: "while (used < 2 && i < count) {",
    replace: "while (false) {",
  },
  {
    name: "huffman/tie-break-changes-tree",
    file: "src/huffman.wac",
    find: "} else if (b < 0 || weight[i] < weight[b]) {",
    replace: "} else if (b < 0 || weight[i] <= weight[b]) {",
    ratioOnly: true,
  },

  // ── Dynamic block header ────────────────────────────────────────────────────
  {
    name: "deflate/hlit-off-by-one",
    file: "src/deflate.wac",
    find: "w.writeBits(hlit - 257, 5); // HLIT",
    replace: "w.writeBits(hlit - 256, 5); // HLIT",
  },
  {
    name: "deflate/hdist-off-by-one",
    file: "src/deflate.wac",
    find: "w.writeBits(hdist - 1, 5);  // HDIST",
    replace: "w.writeBits(hdist, 5);  // HDIST",
  },
  {
    name: "deflate/hclen-off-by-one",
    file: "src/deflate.wac",
    find: "w.writeBits(hclen - 4, 4);  // HCLEN",
    replace: "w.writeBits(hclen - 3, 4);  // HCLEN",
  },
  {
    name: "deflate/cl-order-permutation",
    file: "src/deflate.wac",
    find: "return i32[](16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15);",
    replace: "return i32[](16, 17, 18, 0, 7, 8, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15);",
  },
  {
    name: "deflate/rle-repeat-base",
    file: "src/deflate.wac",
    find: "clPush(s, 18, k - 11);",
    replace: "clPush(s, 18, k - 10);",
  },
  {
    name: "deflate/btype-bits",
    file: "src/deflate.wac",
    find: "w.writeBits(2, 2);          // BTYPE = 10, dynamic Huffman",
    replace: "w.writeBits(1, 2);          // BTYPE = 10, dynamic Huffman",
  },

  // ── gzip container ──────────────────────────────────────────────────────────
  {
    name: "gzip/isize-field",
    file: "src/gzip.wac",
    find: "out.pushU32(data.len());",
    replace: "out.pushU32(data.len() + 1);",
  },
  {
    name: "gzip/stored-nlen",
    file: "src/gzip.wac",
    find: "out.pushU16((~count) & 0xFFFF);",
    replace: "out.pushU16(count & 0xFFFF);",
  },
  {
    name: "gzip/little-endian-u32",
    file: "src/buf.wac",
    find: "void pushU32(this, i32 v) {\n    this.push(v & 0xFF);",
    replace: "void pushU32(this, i32 v) {\n    this.push((v >>> 24) & 0xFF);",
  },

  // ── Inflate ─────────────────────────────────────────────────────────────────
  {
    name: "inflate/crc-check-removed",
    file: "src/inflate.wac",
    find: "if (crc32(out) != wantCrc) { trap; }",
    replace: "if (false) { trap; }",
  },
  {
    name: "inflate/isize-check-removed",
    file: "src/inflate.wac",
    find: "if (out.len() != wantSize) { trap; }",
    replace: "if (false) { trap; }",
  },
  {
    name: "inflate/nlen-check-removed",
    file: "src/inflate.wac",
    find: "if ((len ^ 0xFFFF) != nlen) { trap; }",
    replace: "if (false) { trap; }",
  },
  {
    name: "inflate/distance-bound",
    file: "src/inflate.wac",
    find: "if (d > out.len) { trap; }",
    replace: "if (d > out.len + 1) { trap; }",
    equivalent: "Same redundancy as inflate/distance-check-removed — the one distance this " +
      "lets through still yields a negative index, which Buf.get and wasm both reject.",
  },
  {
    name: "inflate/distance-check-removed",
    file: "src/inflate.wac",
    find: "if (d > out.len) { trap; }",
    replace: "if (false) { trap; }",
    equivalent: "Buf.get's own bounds check still traps on the resulting negative index. " +
      "test/inflate_adversarial.test.ts drives this path; the rejection is just guarded twice.",
  },
  {
    name: "buf/get-bounds-check-removed",
    file: "src/buf.wac",
    find: "i32 get(const this, i32 i) {\n    if (i < 0 || i >= this.len) { trap; }",
    replace: "i32 get(const this, i32 i) {\n    if (false) { trap; }",
    equivalent: "inflate's distance check rejects the stream before Buf.get is reached.",
  },
  {
    // The decisive experiment: remove BOTH guards at once. If this still
    // survives, the behaviour is enforced a third time by wasm's own array
    // bounds check, and no mutation of the wac source can ever be observable —
    // which makes the two survivors above provably equivalent rather than
    // evidence of a coverage gap.
    name: "inflate+buf/all-distance-guards-removed",
    edits: [
      {
        file: "src/inflate.wac",
        find: "if (d > out.len) { trap; }",
        replace: "if (false) { trap; }",
      },
      {
        file: "src/buf.wac",
        find: "i32 get(const this, i32 i) {\n    if (i < 0 || i >= this.len) { trap; }",
        replace: "i32 get(const this, i32 i) {\n    if (false) { trap; }",
      },
    ],
    equivalent: "wasm's array.get bounds check traps on a negative index regardless, " +
      "so out-of-range distances are rejected even with both source-level guards gone.",
  },
  {
    name: "inflate/magic-check-removed",
    file: "src/inflate.wac",
    find: "if (gz[0] != 0x1F || gz[1] != 0x8B) { trap; }   // magic",
    replace: "if (false) { trap; }   // magic",
  },
  {
    name: "inflate/bit-read-order",
    file: "src/inflate.wac",
    find: "v |= this.readBit() << i;",
    replace: "v = (v << 1) | this.readBit();",
  },
  {
    name: "inflate/decoder-first-update",
    file: "src/inflate.wac",
    find: "first = (first + count) << 1;",
    replace: "first = first + count;",
  },
];

const filter = Deno.args[0];
const selected = filter ? MUTATIONS.filter((m) => m.name.includes(filter)) : MUTATIONS;

if (selected.length === 0) {
  console.error(`no mutations match ${JSON.stringify(filter)}`);
  Deno.exit(2);
}

/**
 * Copy the project into a scratch directory, excluding generated output.
 *
 * deno.json's import map points at the wac compiler relatively ("../wac/"),
 * which does not resolve from a temp directory — so it is rewritten to an
 * absolute path. Without this the staged project fails to type-check and *every*
 * mutation reports as killed, which is why there is a control mutation.
 */
async function stageProject(dest: string): Promise<void> {
  for (const entry of ["src", "harness", "test", "deno.json"]) {
    const cmd = new Deno.Command("cp", { args: ["-r", entry, `${dest}/`] });
    const { code, stderr } = await cmd.output();
    if (code !== 0) throw new Error(`copy ${entry} failed: ${new TextDecoder().decode(stderr)}`);
  }

  const configPath = `${dest}/deno.json`;
  const config = JSON.parse(await Deno.readTextFile(configPath));
  const imports = config.imports ?? {};
  for (const [alias, target] of Object.entries(imports)) {
    if (typeof target === "string" && target.startsWith("../")) {
      imports[alias] = await Deno.realPath(target) + "/";
    }
  }
  config.imports = imports;
  await Deno.writeTextFile(configPath, JSON.stringify(config, null, 2));
}

type Result = { mutation: Mutation; killed: boolean; detail: string };
const results: Result[] = [];

console.log(`running ${selected.length} mutations\n`);

for (const m of selected) {
  const work = await Deno.makeTempDir({ prefix: "wac-gzip-mutate-" });
  try {
    await stageProject(work);

    let missing: string | null = null;
    for (const edit of editsOf(m)) {
      const path = `${work}/${edit.file}`;
      const before = await Deno.readTextFile(path);
      if (!before.includes(edit.find)) { missing = edit.file; break; }
      await Deno.writeTextFile(path, before.replace(edit.find, edit.replace));
    }
    if (missing !== null) {
      results.push({
        mutation: m,
        killed: false,
        detail: `PATTERN NOT FOUND in ${missing} — the mutation did not apply, so this result is meaningless`,
      });
      console.log(`  ??  ${m.name.padEnd(38)} pattern not found`);
      continue;
    }

    const cmd = new Deno.Command("deno", {
      args: ["test", "--allow-read", "--allow-write", "--allow-run", "--quiet"],
      cwd: work,
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await cmd.output();
    const output = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);

    // A compile error also counts as killed: the mutation was rejected, which
    // means the behaviour is pinned, just by the compiler rather than a test.
    const killed = code !== 0;
    const firstFail = output.split("\n").find((l) => l.includes("FAILED") || l.includes("error"));
    results.push({ mutation: m, killed, detail: (firstFail ?? "").trim().slice(0, 90) });
    console.log(`  ${killed ? "ok " : "!! "} ${m.name.padEnd(38)} ${killed ? "killed" : "SURVIVED"}`);
  } finally {
    await Deno.remove(work, { recursive: true });
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

const notApplied = results.filter((r) => r.detail.startsWith("PATTERN NOT FOUND"));
const applied = results.filter((r) => !r.detail.startsWith("PATTERN NOT FOUND"));
const controls = applied.filter((r) => r.mutation.mustSurvive);
const real = applied.filter((r) => !r.mutation.mustSurvive);
const survivors = real.filter((r) => !r.killed);
const realSurvivors = survivors.filter((r) => !r.mutation.ratioOnly && !r.mutation.equivalent);
const ratioSurvivors = survivors.filter((r) => r.mutation.ratioOnly);
const equivalentSurvivors = survivors.filter((r) => r.mutation.equivalent && !r.mutation.ratioOnly);

// Validate the harness before reporting anything about the implementation.
const brokenControls = controls.filter((r) => r.killed);
if (brokenControls.length > 0) {
  console.log(`\nHARNESS BROKEN: ${brokenControls.length} no-op control mutation(s) were reported killed.`);
  console.log("Every other result in this run is meaningless — a staged project is failing to");
  console.log("build or run for a reason unrelated to the mutation.");
  for (const r of brokenControls) console.log(`  - ${r.mutation.name}: ${r.detail}`);
  Deno.exit(2);
}

console.log(`\n${real.filter((r) => r.killed).length}/${real.length} mutations killed` +
  (controls.length > 0 ? `  (${controls.length} no-op control(s) correctly survived)` : ""));

if (equivalentSurvivors.length > 0) {
  console.log(`\n${equivalentSurvivors.length} provably unobservable survivor(s):`);
  for (const r of equivalentSurvivors) {
    console.log(`  - ${r.mutation.name}`);
    console.log(`      ${r.mutation.equivalent}`);
  }
}

if (ratioSurvivors.length > 0) {
  console.log(`\n${ratioSurvivors.length} ratio-only survivor(s) — expected, the suite allows ratio slack:`);
  for (const r of ratioSurvivors) console.log(`  - ${r.mutation.name}`);
}

if (notApplied.length > 0) {
  console.log(`\n${notApplied.length} mutation(s) did not apply — update the patterns:`);
  for (const r of notApplied) console.log(`  - ${r.mutation.name} (${r.mutation.file})`);
}

if (realSurvivors.length > 0) {
  console.log(`\n${realSurvivors.length} SURVIVING correctness mutation(s) — untested behaviour:`);
  for (const r of realSurvivors) {
    console.log(`  - ${r.mutation.name}`);
    for (const edit of editsOf(r.mutation)) {
      console.log(`      ${edit.file}: ${edit.find.slice(0, 68)}`);
      console.log(`      ->            ${edit.replace.slice(0, 68)}`);
    }
  }
  Deno.exit(1);
}

console.log("\nno surviving correctness mutations");
