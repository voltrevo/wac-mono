// The vendored SSZ vectors are well-formed and complete.
//
// This checks the *fixtures*, not an implementation — there is no `src/` here yet. It exists because
// a re-run of `tools/vendor.py` is the one thing that can quietly gut the oracle: a listing request
// that 404s, a container renamed upstream, a snappy stream that decodes short. Every one of those
// produces a smaller fixture file rather than an error, and a smaller fixture file makes the future
// SSZ tests *greener*.
//
// So the counts are asserted, not just the shapes. A fixture set that shrinks should fail here before
// anybody concludes their merkleization is fine.
//
// It deliberately does not re-derive any root. That is the job of `packages/ssz` when it exists, and
// a second merkleizer living in the test directory would become the thing under test.

const vendor = (name: string) =>
  Deno.readTextFile(new URL(`vendor/${name}.json`, import.meta.url)).then(JSON.parse);

type Case = { ssz: string; root: string; type?: string; container?: string; case: string };

const HEX = /^[0-9a-f]*$/;

function checkCases(cases: Case[], where: string) {
  const seen = new Set<string>();
  for (const c of cases) {
    const label = `${where}/${c.type ?? c.container}/${c.case}`;
    if (c.root.length !== 64 || !HEX.test(c.root)) {
      throw new Error(`${label}: root is not 32 bytes of lowercase hex: ${c.root}`);
    }
    if (!HEX.test(c.ssz) || c.ssz.length % 2 !== 0) {
      throw new Error(`${label}: ssz is not an even-length hex string`);
    }
    // A duplicate would inflate the count while testing nothing new, which is precisely the failure
    // the counts below are meant to catch.
    const key = `${c.type ?? c.container}/${c.case}`;
    if (seen.has(key)) throw new Error(`${label}: duplicate case`);
    seen.add(key);
  }
}

Deno.test("the light-client ssz_static fixtures are complete", async () => {
  const f = await vendor("ssz_static_altair_mainnet");
  checkCases(f.cases, "ssz_static");
  if (f.cases.length !== 45) {
    throw new Error(`expected 45 ssz_static cases, found ${f.cases.length} — did a re-vendor lose some?`);
  }
  // The nine containers an Altair light client merkleizes or proves a branch into. Named here so a
  // container disappearing upstream is a failure rather than a quietly thinner fixture.
  const want = [
    "BeaconBlockHeader", "SigningData", "SyncCommittee", "SyncAggregate", "LightClientHeader",
    "LightClientUpdate", "LightClientBootstrap", "LightClientFinalityUpdate",
    "LightClientOptimisticUpdate",
  ];
  const have = new Set(f.cases.map((c: Case) => c.container));
  const missing = want.filter((w) => !have.has(w));
  if (missing.length > 0) throw new Error(`no cases for: ${missing.join(", ")}`);
  if (have.size !== want.length) {
    throw new Error(`unexpected containers: ${[...have].filter((h) => !want.includes(h as string))}`);
  }
});

Deno.test("the ssz_generic fixtures are complete, and say what they dropped", async () => {
  const f = await vendor("ssz_generic_valid");
  checkCases(f.cases, "ssz_generic");
  if (f.cases.length !== 1148) {
    throw new Error(`expected 1148 ssz_generic cases, found ${f.cases.length}`);
  }
  const want = ["uints", "boolean", "bitlist", "bitvector", "basic_vector", "containers"];
  const have = new Set(f.cases.map((c: Case) => c.type));
  const missing = want.filter((w) => !have.has(w));
  if (missing.length > 0) throw new Error(`no cases for: ${missing.join(", ")}`);

  // The cap is recorded in the data, not only in the README, so the omission travels with the file.
  if (f.sizeCap !== 8192) throw new Error(`sizeCap changed to ${f.sizeCap} without updating this test`);
  if (f.dropped !== 69) throw new Error(`dropped count changed to ${f.dropped}`);
  for (const c of f.cases as Case[]) {
    if (c.ssz.length / 2 > f.sizeCap) {
      throw new Error(`${c.type}/${c.case} is ${c.ssz.length / 2} bytes, over the stated cap`);
    }
  }
});

Deno.test("no case is a placeholder, and a zero root only occurs where the bytes are zero", async () => {
  // A snappy stream that decoded to nothing, or a root read off the wrong line, shows up as a uniform
  // value rather than as an exception, so it is worth an explicit check.
  //
  // An all-zero root is **legitimate**, which my first version of this test got wrong: an all-zero
  // value that fits in one 32-byte chunk merkleizes to a zero chunk, so all 61 `*_zero` cases have
  // one. The invariant that does hold is the implication — zero root only where the serialization is
  // itself all zeros — and it is a real check on both halves of the case rather than on one.
  //
  // Distinctness is not a useful check here and the numbers say why: `ssz_generic` has 1,148 cases and
  // only 246 distinct roots, because cases of different types serialize identically (`vec_uint8_1_zero`
  // and `vec_bool_1_zero` are both a single zero byte). A percentage threshold would be pinning a
  // coincidence.
  for (const name of ["ssz_static_altair_mainnet", "ssz_generic_valid"]) {
    const f = await vendor(name);
    const zero = "0".repeat(64);
    for (const c of f.cases as Case[]) {
      const label = `${name}/${c.type ?? c.container}/${c.case}`;
      if (c.ssz.length === 0) throw new Error(`${label}: no serialized bytes`);
      if (c.root === zero && /[^0]/.test(c.ssz)) {
        throw new Error(`${label}: zero root but non-zero bytes — a root parsed from the wrong place?`);
      }
    }
    // Catastrophic uniformity: every root identical would pass every per-case check above.
    const roots = new Set((f.cases as Case[]).map((c) => c.root));
    if (roots.size < 40) throw new Error(`${name}: only ${roots.size} distinct roots across ${f.cases.length} cases`);
  }
});
