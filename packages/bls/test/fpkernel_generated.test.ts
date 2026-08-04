// `src/fpkernel.wac` is generated. This fails when the checked-in file is not what the generator
// produces, which is the only thing that stops the two drifting apart.
//
// Drift here would be quiet in the worst way. The file is a thousand lines of unrolled arithmetic
// with the modulus baked in as immediates; nobody is going to read a diff of it. If someone tunes
// the generator and forgets to re-run it, or hand-patches the output, the vectors still pass — the
// checked-in code is what runs — and the generator becomes a lie about what is in the tree.
//
// This checks the bytes rather than re-deriving the arithmetic, because the arithmetic already has
// an oracle: `fp_wac.test.ts` compares several hundred multiplications, additions and subtractions against Python's own
// integers, so a wrong immediate fails there. What that cannot see is the generator and its output
// disagreeing, which is what this covers.

const generated = new URL("../src/fpkernel.wac", import.meta.url);
const generator = new URL("../tools/genfpkernel.py", import.meta.url);

Deno.test("src/fpkernel.wac is current — run `deno task gen:bls-fpkernel`", async () => {
  const r = await new Deno.Command("python3", {
    args: [generator.pathname, "--stdout"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (r.code !== 0) {
    throw new Error(`genfpkernel.py failed:\n${new TextDecoder().decode(r.stderr).trim()}`);
  }
  const want = new TextDecoder().decode(r.stdout);
  const have = await Deno.readTextFile(generated);
  if (have === want) return;

  // Point at the first difference: a whole-file diff of unrolled arithmetic tells you nothing.
  const h = have.split("\n"), w = want.split("\n");
  const at = h.findIndex((line, i) => line !== w[i]);
  const where = at < 0
    ? `identical for ${Math.min(h.length, w.length)} lines, then one is longer ` +
      `(checked in ${h.length}, generated ${w.length})`
    : `first difference at line ${at + 1}:\n  checked in: ${h[at]}\n  generated:  ${w[at] ?? "(end of file)"}`;
  throw new Error(`src/fpkernel.wac is not what tools/genfpkernel.py produces.\n${where}`);
});
