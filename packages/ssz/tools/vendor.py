#!/usr/bin/env python3
"""Turn Ethereum's SSZ test vectors into compact JSON this repo can commit.

    python3 packages/ssz/tools/vendor.py static   # light-client containers, fetched case by case
    python3 packages/ssz/tools/vendor.py generic  # ssz_generic, from a downloaded general.tar.gz

Writes `packages/ssz/test/vendor/*.json`. **Run this by hand, not from a test.** The committed JSON
is the fixture; the tests never touch the network, so a download that fails cannot make them pass.

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
repo is 2.47 GB. Do not clone it. `ssz_static` is fetched case by case over
`raw.githubusercontent.com` — the light-client containers are about forty cases — while `ssz_generic`
has over a thousand and is taken from `general.tar.gz` in one request instead of thousands.

The repo is archived as of 2025-10-21; `v1.6.0-beta.0` is the last release, so this is a fixed target.
"""
import json
import pathlib
import subprocess
import sys
import tarfile

REPO = "ethereum/consensus-spec-tests"
REF = "master"
RAW = f"https://raw.githubusercontent.com/{REPO}/{REF}"
API = f"https://api.github.com/repos/{REPO}/contents"

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


def do_static() -> None:
    cases = []
    for container in LIGHT_CLIENT:
        base = f"tests/{CONFIG}/{FORK}/ssz_static/{container}"
        suites = json.loads(fetch(f"{API}/{base}?ref={REF}"))
        for suite in sorted(x["name"] for x in suites):
            listing = json.loads(fetch(f"{API}/{base}/{suite}?ref={REF}"))
            for case in sorted(x["name"] for x in listing):
                d = f"{base}/{suite}/{case}"
                ssz = snappy_block(fetch(f"{RAW}/{d}/serialized.ssz_snappy"))
                root = root_of(fetch(f"{RAW}/{d}/roots.yaml"))
                cases.append({
                    "container": container,
                    "case": f"{suite}/{case}",
                    "ssz": ssz.hex(),
                    "root": root[2:],
                })
                print(f"  {container}/{suite}/{case}: {len(ssz)} bytes", file=sys.stderr)
    write("ssz_static_altair_mainnet.json", {
        "source": f"{REPO} v1.6.0-beta.0, {CONFIG}/{FORK}/ssz_static",
        "cases": cases,
    })


# Cases above this many serialized bytes are dropped. The whole `ssz_generic` valid set is 47 MB of
# JSON, essentially all of it `containers`: 463 cases totalling 24 MB, the largest a single 1.76 MB
# `ComplexTestStruct`. Those long-list cases repeat structure the small ones already cover — offsets,
# nesting, variable-size members — so the cap costs coverage of *length* rather than of shape.
#
# 8 KB keeps 1148 of 1217 cases in about 930 KB, against `packages/bls/test/vendor`'s 68 KB. The
# script reports what it dropped rather than trimming quietly, and raising the cap and re-running is
# the way to test long-list merkleization if that turns out to matter.
SIZE_CAP = 8192


def do_generic(tarball: str) -> None:
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
    dropped = [c for c in complete if len(c["ssz"]) // 2 > SIZE_CAP]
    cases.sort(key=lambda c: (c["type"], c["case"]))
    biggest = max((len(c["ssz"]) // 2 for c in dropped), default=0)
    print(f"  {len(complete)} valid cases across {len(want)} types; kept {len(cases)}, "
          f"dropped {len(dropped)} over {SIZE_CAP} bytes (largest {biggest})", file=sys.stderr)
    write("ssz_generic_valid.json", {
        "source": f"{REPO} v1.6.0-beta.0, general/phase0/ssz_generic (valid only)",
        "sizeCap": SIZE_CAP,
        "dropped": len(dropped),
        "droppedLargestBytes": biggest,
        "cases": cases,
    })


def write(name: str, payload: dict) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / name
    path.write_text(json.dumps(payload, separators=(",", ":"), sort_keys=False))
    kb = path.stat().st_size / 1024
    print(f"{path.relative_to(pathlib.Path.cwd())}: {len(payload['cases'])} cases, {kb:.0f} KB")


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "static"
    if what == "static":
        do_static()
    elif what == "generic":
        if len(sys.argv) < 3:
            sys.exit("usage: vendor.py generic <path to general.tar.gz>")
        do_generic(sys.argv[2])
    else:
        sys.exit(f"unknown target {what!r}; expected 'static' or 'generic'")
