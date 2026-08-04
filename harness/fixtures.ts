// Test fixtures derived from a pinned upstream revision, cached outside git, verified by hash.
//
// Some packages test against large published vector sets — `packages/ssz` against Ethereum's
// consensus spec tests, whose full `ssz_generic` suite is 47 MB derived and 211 MB to download.
// Committing that is the obvious thing and the wrong one: the repo is 27 MB today, one package's
// *partial* vectors were already 1.7 MB of it, and the sets worth having next (about 2,100 invalid
// cases, other forks, other configs) are larger again.
//
// So git holds the generator and a manifest; `.cache/fixtures` holds the data. The manifest pins an
// upstream **commit SHA** and the SHA-256 of each derived set.
//
// ## What this must not break
//
// `packages/bls/test/vendor/README.md` states the property vendoring bought: *"Committed rather than
// fetched, so the tests need no network and cannot silently start passing because a download
// failed."* That is exactly right and it is the thing a cache is most likely to lose.
//
// It is preserved by two rules, and they are the whole design:
//
// **A fixture that cannot be produced is an error, never a skip.** No `if (!cached) return`, no
// conditional `Deno.test`. A suite that quietly drops its oracle when the proxy allowlist changes
// reports a better number for being less able to check anything — the same failure shape as a red
// baseline scoring every mutant as killed.
//
// **The expected hash is committed, so the data cannot drift.** This is *stronger* than vendoring.
// Nothing currently checks that a vendored JSON still matches upstream; a case mis-decompressed at
// vendoring time is baked in for ever and every future run agrees with it. Here the derived bytes
// are checked against a hash that a human put in the manifest, so a changed generator, a corrupted
// download or a substituted file all fail loudly and name themselves.
//
// ## What it costs, stated rather than discovered
//
// A cold cache needs the network, and for `ssz_generic` that is a 211 MB download — once per machine,
// because `.cache` persists. `deleting .cache is always safe` stays true, but it stops being *free*.
// That is the trade: a 27 MB repo that needs one network round on a fresh checkout, against a repo
// that grows without bound as more vector sets arrive.
//
// ## Where the line is
//
// Not everything should move. `packages/bls/test/vendor` is 68 KB and stays committed: below some
// size the offline property is worth more than the bytes, and a rule that moves 68 KB out of git has
// lost sight of why. **Roughly: vendor under a hundred kilobytes, cache above it.**

const CACHE_DIR = ".cache/fixtures";

/** What a package commits: where its fixtures come from and what they should hash to. */
export type FixtureManifest = {
  /** For a human reading a failure: what this is and where it came from. */
  source: string;
  /** A **commit SHA**, not a tag or branch. A tag can be moved; this cannot. */
  commit: string;
  /** How to rebuild, quoted in the error when a fixture is missing. */
  rebuild: string;
  sets: Record<string, { sha256: string; note?: string }>;
};

// Web Crypto, which is a global here — no import, and therefore nothing for the proxy allowlist to
// block. `deno.land/std` was the first thing tried and is not reachable from this container.
const hex = (b: ArrayBuffer) =>
  Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, "0")).join("");

async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource));
}

/**
 * The bytes of fixture set `name`, from the cache or by running the package's generator.
 *
 * Throws — never returns a fallback, never skips — if the set cannot be produced or does not match
 * the manifest. The message says how to rebuild, because the person reading it is usually somebody
 * who has just cloned the repo.
 */
export async function fixtureBytes(
  pkg: string,
  name: string,
  manifest: FixtureManifest,
): Promise<Uint8Array> {
  const want = manifest.sets[name];
  if (want === undefined) throw new Error(`${pkg}: no fixture set named ${name} in the manifest`);

  // Content-addressed by the *expected* hash, so changing the manifest changes the path and a stale
  // cache entry can never be read as a current one.
  const path = `${CACHE_DIR}/${pkg}-${name}-${want.sha256.slice(0, 16)}.json`;
  try {
    const cached = await Deno.readFile(path);
    const got = await sha256(cached);
    if (got === want.sha256) return cached;
    // A cache file whose name says one hash and whose content says another has been corrupted;
    // fall through and rebuild rather than trusting either.
    console.error(`fixtures: ${path} is corrupt (${got.slice(0, 16)}…), rebuilding`);
  } catch {
    // Not cached yet. Build it.
  }

  const built = await build(pkg, name, manifest, path);
  const got = await sha256(built);
  if (got !== want.sha256) {
    throw new Error(
      `fixtures: ${pkg}/${name} does not match the manifest.\n` +
        `  expected ${want.sha256}\n  produced ${got}\n` +
        `  The generator, the upstream data at ${manifest.commit.slice(0, 12)}, or the manifest is ` +
        `wrong.\n  If the generator changed deliberately, update the sha256 in the manifest.`,
    );
  }
  await Deno.mkdir(CACHE_DIR, { recursive: true });
  await Deno.writeFile(path, built);
  return built;
}

/** As `fixtureBytes`, parsed. */
export async function fixtureJson<T = unknown>(
  pkg: string,
  name: string,
  manifest: FixtureManifest,
): Promise<T> {
  return JSON.parse(new TextDecoder().decode(await fixtureBytes(pkg, name, manifest)));
}

async function build(
  pkg: string,
  name: string,
  manifest: FixtureManifest,
  target: string,
): Promise<Uint8Array> {
  const cmd = new Deno.Command("python3", {
    args: [`packages/${pkg}/tools/vendor.py`, name, "--commit", manifest.commit, "--stdout"],
    stdout: "piped",
    stderr: "piped",
  });
  let out;
  try {
    out = await cmd.output();
  } catch (e) {
    throw new Error(
      `fixtures: cannot run the generator for ${pkg}/${name}: ${e}\n` +
        `  ${manifest.rebuild}`,
    );
  }
  if (out.code !== 0) {
    const err = new TextDecoder().decode(out.stderr).trim();
    throw new Error(
      `fixtures: ${pkg}/${name} could not be produced.\n` +
        `  source: ${manifest.source} @ ${manifest.commit.slice(0, 12)}\n` +
        `  ${manifest.rebuild}\n` +
        `  This needs network on a cold cache. It is an error and not a skip on purpose: a suite\n` +
        `  that silently drops its oracle reports a better number for checking less.\n` +
        `  ---\n  ${err.split("\n").slice(-6).join("\n  ")}`,
    );
  }
  return out.stdout;
}
