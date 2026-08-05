#!/usr/bin/env python3
"""Turn Ethereum's SSZ test vectors into compact JSON this repo can commit.

    python3 packages/ssz/tools/vendor.py ssz_static_altair_mainnet --stdout
    python3 packages/ssz/tools/vendor.py ssz_generic_valid --stdout

Writes the fixture set to stdout. `harness/fixtures.ts` runs this on a cold cache, checks the output
against the SHA-256 committed in `test/fixtures.json`, and caches it under `.cache/fixtures`.

**The data is not committed; the manifest is.** git holds this generator and a pinned commit SHA plus
the expected hash of each set — see `harness/fixtures.ts` for why, and for the rule that a fixture
which cannot be produced is an error and never a skip.

## Why the vectors are reshaped rather than committed as they come

A case in `ethereum/consensus-spec-tests` is a directory of three files:

    roots.yaml               75 bytes    root: '0x27d8…'      (ssz_generic calls this meta.yaml)
    serialized.ssz_snappy    25 KB       the bytes under test
    value.yaml               56 KB       the same value, structured

Committing that shape would put a YAML reader and a snappy decompressor in the repo to read its own
test data. Both are done here instead, once, and the output is `{ssz, root}` in hex — the same choice
`packages/bls/test/vendor` made when it turned the Ethereum BLS suite's YAML into JSON.

`value.yaml` is dropped. It is the bulk of the download and the interesting assertion does not need
it: `hash_tree_root(deserialize(ssz)) == root` exercises deserialization and merkleization together,
against a root this repo had no hand in producing.

## The snappy trap

The files are named `.ssz_snappy` and are **not** framed snappy — there is no `sNaPpY` stream header.
They are the raw block format: a varint uncompressed length, then the tag stream. The first case
checked began `98 c6 01`, which is 25368, and decoding produced exactly 25368 bytes. A framed
decoder would have rejected the first byte.

## Sizes, because this repo shares a disk

The release tarballs are 211 MB (`general`), 468 MB (`minimal`) and 679 MB (`mainnet`), and the git
repo is 2.47 GB. Do not clone it. `ssz_static` is fetched case by case over `raw.githubusercontent.com` — 90 files, no API calls, see
the note by `SUITE` — while `ssz_generic` has over a thousand cases and comes from `general.tar.gz`
in one request instead of thousands.

The repo is archived as of 2025-10-21; `v1.6.0-beta.0` is the last release, so this is a fixed target.
"""
import json
import pathlib
import subprocess
import sys
import tarfile

REPO = "ethereum/consensus-spec-tests"
# A commit SHA, not a tag: `v1.6.0-beta.0` resolves to this, and a tag can be moved where a commit
# cannot. The repo is archived as of 2025-10-21, so this is also simply the last state it will have.
COMMIT = "bc5c1a7fb2a8871aaffd4b16ee4dd9c72bb81908"
REF = COMMIT
RAW = f"https://raw.githubusercontent.com/{REPO}/{REF}"

# The containers an Altair light client merkleizes or verifies a branch into. Read off
# `consensus-specs/specs/altair/light-client/sync-protocol.md` rather than chosen by eye.
LIGHT_CLIENT = [
    "BeaconBlockHeader",
    "SigningData",
    "SyncCommittee",
    "SyncAggregate",
    "LightClientHeader",
    "LightClientUpdate",
    "LightClientBootstrap",
    "LightClientFinalityUpdate",
    "LightClientOptimisticUpdate",
]

# `mainnet`, not `minimal`: SYNC_COMMITTEE_SIZE differs (512 against 32), so a `SyncCommittee` root
# from the minimal config would be a root for a different type.
CONFIG = "mainnet"
FORK = "altair"

OUT = pathlib.Path(__file__).resolve().parents[1] / "test" / "vendor"


def snappy_block(d: bytes) -> bytes:
    """Snappy block-format decompression. Not the framed format — see the module docstring."""
    n, shift, i = 0, 0, 0
    while True:
        b = d[i]
        i += 1
        n |= (b & 0x7F) << shift
        if not b & 0x80:
            break
        shift += 7
    out = bytearray()
    while i < len(d):
        tag = d[i]
        kind = tag & 0x03
        if kind == 0:                                   # literal
            ln = tag >> 2
            if ln < 60:
                i += 1
            else:
                extra = ln - 59
                i += 1
                ln = int.from_bytes(d[i:i + extra], "little")
                i += extra
            ln += 1
            out += d[i:i + ln]
            i += ln
        else:
            if kind == 1:                               # copy, 1-byte offset
                ln = 4 + ((tag >> 2) & 0x07)
                off = ((tag >> 5) << 8) | d[i + 1]
                i += 2
            elif kind == 2:                             # copy, 2-byte offset
                ln = (tag >> 2) + 1
                off = int.from_bytes(d[i + 1:i + 3], "little")
                i += 3
            else:                                       # copy, 4-byte offset
                ln = (tag >> 2) + 1
                off = int.from_bytes(d[i + 1:i + 5], "little")
                i += 5
            start = len(out) - off
            if start < 0:
                raise ValueError("copy offset reaches before the start of the output")
            for k in range(ln):                          # may overlap itself, so byte at a time
                out.append(out[start + k])
    if len(out) != n:
        raise ValueError(f"length header says {n}, decoded {len(out)}")
    return bytes(out)


def fetch(url: str) -> bytes:
    """One request, via curl so the container's proxy configuration applies."""
    r = subprocess.run(["curl", "-sSfL", url], capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"fetch {url}: {r.stderr.decode().strip()}")
    return r.stdout


def root_of(yaml_bytes: bytes) -> str:
    """One line, `root: '0x…'`, in `roots.yaml` or `meta.yaml`. No YAML reader for one key."""
    text = yaml_bytes.decode()
    key = "root:"
    at = text.index(key) + len(key)
    val = text[at:].strip().strip("'\"")
    if not val.startswith("0x") or len(val) != 66:
        raise ValueError(f"not a 32-byte root: {val!r}")
    return val


# The case layout at the pinned commit: one suite, five cases per container. Enumerated rather than
# listed, and that is the point of pinning — at a fixed commit the tree cannot change, so asking
# GitHub what is in a directory buys nothing and costs a lot.
#
# **The API is 60 requests an hour unauthenticated.** Listing nine containers plus their suites is
# ~10 of those per rebuild, so a few cold rebuilds in an hour exhaust the quota and every one after
# that fails with a 403 that looks nothing like a rate limit. Found by doing exactly that. Raw file
# fetches go to `raw.githubusercontent.com`, which is a different service and not subject to it —
# verified while the API quota was at zero.
SUITE = "ssz_random"
CASES = ["case_0", "case_1", "case_2", "case_3", "case_4"]


def do_static() -> dict:
    cases = []
    for container in LIGHT_CLIENT:
        base = f"tests/{CONFIG}/{FORK}/ssz_static/{container}/{SUITE}"
        for case in CASES:
            d = f"{base}/{case}"
            # A 404 here means the pinned tree is not shaped as expected, which is a real error
            # rather than a case to skip — `fetch` raises.
            ssz = snappy_block(fetch(f"{RAW}/{d}/serialized.ssz_snappy"))
            root = root_of(fetch(f"{RAW}/{d}/roots.yaml"))
            cases.append({
                "container": container,
                "case": f"{SUITE}/{case}",
                "ssz": ssz.hex(),
                "root": root[2:],
            })
            print(f"  {container}/{SUITE}/{case}: {len(ssz)} bytes", file=sys.stderr)
    return {
        "source": f"{REPO} @ {COMMIT[:12]}, {CONFIG}/{FORK}/ssz_static",
        "cases": cases,
    }


# No size cap any more. It existed because the output went into git, where the full 47 MB set was out
# of the question; the cache has no such limit, so the 69 cases previously dropped — including a
# 1.76 MB `ComplexTestStruct` that is the only real exercise of long-list merkleization — are back.
# Kept as a knob rather than deleted, because a future set may need one.
SIZE_CAP = 1 << 30


def do_generic(tarball: str) -> dict:
    """`ssz_generic` from a downloaded `general.tar.gz`: one request rather than thousands."""
    want = ("uints", "bitlist", "bitvector", "boolean", "basic_vector", "containers")
    found: dict[tuple[str, str, str], dict] = {}
    with tarfile.open(tarball) as tf:
        for m in tf:
            parts = m.name.split("/")
            # tests/general/phase0/ssz_generic/<type>/<valid|invalid>/<case>/<file>
            if len(parts) < 8 or parts[3] != "ssz_generic" or parts[4] not in want:
                continue
            typ, validity, case, fname = parts[4], parts[5], parts[6], parts[7]
            # `ssz_generic` names its root file `meta.yaml`, where `ssz_static` uses `roots.yaml`.
            # Both hold one `root: '0x…'` line. Only the *valid* cases carry a root at all — an
            # invalid case ships `serialized.ssz_snappy` alone, because the expected outcome is a
            # refusal, and pairing those with a root would be inventing one.
            if validity != "valid" or fname not in ("serialized.ssz_snappy", "meta.yaml"):
                continue
            data = tf.extractfile(m).read()
            e = found.setdefault((typ, validity, case), {"type": typ, "case": case})
            if fname == "meta.yaml":
                e["root"] = root_of(data)[2:]
            else:
                e["ssz"] = snappy_block(data).hex()
    complete = [v for v in found.values() if "root" in v and "ssz" in v]
    cases = [c for c in complete if len(c["ssz"]) // 2 <= SIZE_CAP]
    dropped = len(complete) - len(cases)
    cases.sort(key=lambda c: (c["type"], c["case"]))
    print(f"  {len(complete)} valid cases across {len(want)} types; kept {len(cases)}, "
          f"dropped {dropped}", file=sys.stderr)
    return {
        "source": f"{REPO} @ {COMMIT[:12]}, general/phase0/ssz_generic (valid only)",
        "dropped": dropped,
        "cases": cases,
    }


def write(name: str, payload: dict) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / name
    path.write_text(json.dumps(payload, separators=(",", ":"), sort_keys=False))
    kb = path.stat().st_size / 1024
    print(f"{path.relative_to(pathlib.Path.cwd())}: {len(payload['cases'])} cases, {kb:.0f} KB")


def write(name: str, payload: dict) -> None:
    """Kept for running this by hand; the harness uses --stdout."""
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / name
    path.write_text(json.dumps(payload, separators=(",", ":"), sort_keys=False))
    print(f"{path}: {len(payload['cases'])} cases, {path.stat().st_size / 1024:.0f} KB",
          file=sys.stderr)


def tarball_path() -> str:
    """Where `general.tar.gz` is cached, downloading it if this is the first time.

    211 MB, once per machine. It is not kept in `.cache/fixtures` with the derived sets because it is
    an input rather than a fixture, and because deleting it should not invalidate anything.
    """
    cache = pathlib.Path(".cache/upstream")
    cache.mkdir(parents=True, exist_ok=True)
    tar = cache / f"general-{COMMIT[:12]}.tar.gz"
    if not tar.exists():
        url = (f"https://github.com/{REPO}/releases/download/v1.6.0-beta.0/general.tar.gz")
        print(f"  fetching {url} (211 MB, once)", file=sys.stderr)
        r = subprocess.run(["curl", "-sSfL", "-o", str(tar), url])
        if r.returncode != 0:
            if tar.exists():
                tar.unlink()
            raise RuntimeError("could not download general.tar.gz")
    return str(tar)


# The light client's own Merkle-proof vectors: three proofs into one `BeaconState`, per fork.
#
# `object.ssz_snappy` is deliberately **not** vendored. Using it would need a full `BeaconState`
# descriptor, which a light client never merkleizes — it verifies branches *into* a state root it is
# handed. The three proofs are checkable without it: they share one object, so three different
# gindexes at three different depths must fold to one root, which is an oracle with no circularity in
# it. The object is upstream if `hash_tree_root(BeaconState)` ever exists.
PROOF_FORKS = ["altair", "deneb", "electra"]
PROOF_CASES = [
    "current_sync_committee_merkle_proof",
    "next_sync_committee_merkle_proof",
    "finality_root_merkle_proof",
]


def do_proofs() -> dict:
    import re
    cases = []
    for fork in PROOF_FORKS:
        for case in PROOF_CASES:
            d = f"tests/{CONFIG}/{fork}/light_client/single_merkle_proof/BeaconState/{case}"
            text = fetch(f"{RAW}/{d}/proof.yaml").decode()
            leaf = re.search(r"leaf: '0x([0-9a-f]+)'", text).group(1)
            gindex = int(re.search(r"leaf_index: (\d+)", text).group(1))
            branch = re.findall(r"^- '0x([0-9a-f]+)'", text, re.M)
            assert len(leaf) == 64 and all(len(b) == 64 for b in branch), f"{d}: bad hex"
            cases.append({"fork": fork, "case": case, "leaf": leaf,
                          "gindex": gindex, "branch": branch})
            print(f"  {fork}/{case}: gindex {gindex}, depth {len(branch)}", file=sys.stderr)
    return {
        "source": f"{REPO} @ {COMMIT[:12]}, {CONFIG}/*/light_client/single_merkle_proof",
        "cases": cases,
    }


# The sync-protocol tests, which exist only in the `minimal` config — SYNC_COMMITTEE_SIZE 32 rather
# than 512, so a client checked against them needs minimal-config descriptors as well as mainnet ones.
#
# **No directory listing.** Each case's `steps.yaml` names every update file it uses, so the file set
# is derivable from two fetches rather than from the GitHub API — which is 60 requests an hour and was
# exhausted once already by listing.
SYNC_FORK = "altair"
SYNC_CASES = [
    "light_client_sync",
    "light_client_sync_no_force_update",
    "advance_finality_without_sync_committee",
    "supply_sync_committee_from_past_update",
    # The `*_store_with_legacy_data` cases are deliberately absent: they exercise `upgrade_store`
    # across forks, which needs the capella/deneb/electra container descriptors this package does not
    # have. Adding them is a fork-support question, not a sync-protocol one.
]


def parse_steps(text: str) -> list:
    """The restricted YAML in `steps.yaml`: a list of one-key maps of nested scalar maps.

    Hand-written because there is no pyyaml here, and targeted rather than general — every shape it
    does not expect raises instead of guessing.

    The one wrinkle is that a key may carry its value on the **following** line, indented under it
    (`update:` then the filename), which is textually indistinguishable from the start of a nested map
    until you look for a colon. Two attempts at resolving that during the walk both put the scalar in
    the wrong map, so it is now removed by a **pre-pass** that folds such a line back onto its key.
    Deciding it before parsing is what makes the parser itself trivial.
    """
    raw = [(len(r) - len(r.lstrip(" ")), r.strip()) for r in text.splitlines() if r.strip()]

    # Pre-pass: `key:` followed by a deeper line with no colon is one `key: value`.
    lines: list = []
    i = 0
    while i < len(raw):
        indent, line = raw[i]
        if (line.endswith(":") and not line.startswith("- ") and i + 1 < len(raw)
                and raw[i + 1][0] > indent and ":" not in raw[i + 1][1]):
            lines.append((indent, f"{line} {raw[i + 1][1]}"))
            i += 2
            continue
        assert ":" in line, f"a value with no key: {line!r}"
        lines.append((indent, line))
        i += 1

    steps: list = []
    owner: dict = {}                     # indent -> the map that keys at that indent belong to
    for indent, line in lines:
        if line.startswith("- "):
            key = line[2:]
            assert key.endswith(":") and ":" not in key[:-1], f"unexpected step header {line!r}"
            step = {"kind": key[:-1]}
            steps.append(step)
            owner = {indent: step}
            continue
        assert steps, f"content before any step: {line!r}"
        parent_indent = max((d for d in owner if d < indent), default=None)
        assert parent_indent is not None, f"orphan line at indent {indent}: {line!r}"
        parent = owner[parent_indent]
        key, _, val = line.partition(":")
        key, val = key.strip(), val.strip()
        if val == "":
            child: dict = {}
            parent[key] = child
            owner[indent] = child
        else:
            parent[key] = val.strip("'\"")
    return steps


def do_sync() -> dict:
    cases = []
    for name in SYNC_CASES:
        base = f"tests/minimal/{SYNC_FORK}/light_client/sync/pyspec_tests/{name}"
        meta_text = fetch(f"{RAW}/{base}/meta.yaml").decode()
        meta = {}
        for line in meta_text.splitlines():
            if ":" in line:
                k, _, v = line.partition(":")
                meta[k.strip()] = v.strip().strip("'\"")
        steps = parse_steps(fetch(f"{RAW}/{base}/steps.yaml").decode())
        assert steps, f"{name}: no steps parsed"

        wanted = sorted({st["update"] for st in steps if "update" in st})
        updates = {}
        for u in wanted:
            updates[u] = snappy_block(fetch(f"{RAW}/{base}/{u}.ssz_snappy")).hex()
        bootstrap = snappy_block(fetch(f"{RAW}/{base}/bootstrap.ssz_snappy")).hex()
        kinds = sorted({st["kind"] for st in steps})
        print(f"  {name}: {len(steps)} steps {kinds}, {len(updates)} update(s), "
              f"bootstrap {len(bootstrap)//2} bytes", file=sys.stderr)
        cases.append({"case": name, "meta": meta, "steps": steps,
                      "bootstrap": bootstrap, "updates": updates})
    return {
        "source": f"{REPO} @ {COMMIT[:12]}, minimal/{SYNC_FORK}/light_client/sync",
        "cases": cases,
    }


BUILDERS = {
    "light_client_sync_altair_minimal": lambda: do_sync(),
    "light_client_proofs": lambda: do_proofs(),
    "ssz_static_altair_mainnet": lambda: do_static(),
    "ssz_generic_valid": lambda: do_generic(tarball_path()),
}


if __name__ == "__main__":
    args = [a for a in sys.argv[1:]]
    if "--commit" in args:
        i = args.index("--commit")
        want = args[i + 1]
        if want != COMMIT:
            sys.exit(f"manifest pins {want[:12]}, this generator is pinned to {COMMIT[:12]}")
        del args[i:i + 2]
    to_stdout = "--stdout" in args
    if to_stdout:
        args.remove("--stdout")
    if not args or args[0] not in BUILDERS:
        sys.exit(f"usage: vendor.py <{'|'.join(BUILDERS)}> [--commit SHA] [--stdout]")
    payload = BUILDERS[args[0]]()
    text = json.dumps(payload, separators=(",", ":"), sort_keys=False)
    if to_stdout:
        sys.stdout.write(text)
    else:
        write(f"{args[0]}.json", payload)
