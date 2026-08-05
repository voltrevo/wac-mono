#!/usr/bin/env python3
"""Capture tor's proposal-228 key derivation by calling tor's own code.

`routerdesc_vectors.json` pins the curve25519 -> ed25519 conversion for *public* keys, using
certificates real relays published. It cannot pin the secret-side derivation
(`curve25519ToEd25519Secret`), and the reason is worth stating because it is easy to assume otherwise:
the string that derivation hashes contributes only the nonce prefix — the second half of the expanded
secret — and a public key does not depend on the prefix at all. Every public-key comparison passes
with the string wrong.

Nor does tor's committed test data cover it. `test_crypto_ed25519_testvectors` derives the keypair and
then overwrites the secret with an ordinary ed25519 key before signing, so no vector in tor exercises
a signature made with a proposal-228 prefix.

So this links `prop228-probe.c` against tor's static library and asks tor directly. The signature in
the output is what makes the prefix observable: ed25519 is deterministic, so a signature over a fixed
message is a fingerprint of the entire 64-byte expanded secret, string and terminating NUL included.

Needs a *built* tor source tree — `libtor.a` at its root, which `configure && make` leaves there.

    python3 packages/tor/tools/capture-prop228.py [tor-source-dir] > \
        packages/tor/test/data/prop228_vectors.json
"""
import json
import pathlib
import re
import subprocess
import sys
import tempfile

DEFAULT_TOR = pathlib.Path.home() / "tor-build" / "torproject-tor-c8d2b17"
MESSAGE = b"prop228 nonce prefix, pinned"


def build(root, probe, out):
    cmd = [
        "gcc", "-O1", "-o", str(out), str(probe),
        f"-I{root}", f"-I{root}/src", f"-I{root}/src/ext", f"-I{root}/src/ext/trunnel",
        str(root / "libtor.a"),
        "-lssl", "-lcrypto", "-lz", "-lm", "-levent", "-lpthread",
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"compiling the probe failed:\n{r.stderr}")


def parse(text):
    cases = []
    current = None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("case "):
            current = {}
            cases.append(current)
            continue
        if current is None:
            continue
        # The sign bit is a number, and "1" is also valid hex — so it has to be matched before the
        # generic field pattern, or it lands in the case as a string and every comparison against it
        # silently fails.
        m = re.match(r"^signbit ([01])$", line)
        if m:
            current["signbit"] = int(m.group(1))
            continue
        m = re.match(r"^(\w+) ([0-9a-f]+)$", line)
        if m:
            current[m.group(1)] = m.group(2)
    return cases


def main():
    root = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_TOR
    if not (root / "libtor.a").exists():
        sys.exit(f"{root}/libtor.a: not found — the tor tree must be configured and built")
    probe = pathlib.Path(__file__).with_name("prop228-probe.c")

    with tempfile.TemporaryDirectory() as tmp:
        binary = pathlib.Path(tmp) / "prop228"
        build(root, probe, binary)
        r = subprocess.run([str(binary)], capture_output=True, text=True)
        if r.returncode != 0:
            sys.exit(f"the probe failed:\n{r.stdout}\n{r.stderr}")
        cases = parse(r.stdout)

    if not cases:
        sys.exit("the probe printed nothing this script recognised")

    for i, c in enumerate(cases):
        need = {"curve_secret", "curve_public", "expanded", "ed_public", "signature", "signbit"}
        missing = need - set(c)
        if missing:
            sys.exit(f"case {i}: missing {sorted(missing)}")
        # The scalar half of the expanded secret is the curve25519 secret verbatim; if that is not so
        # the derivation has changed shape and the wac side's assumptions are stale.
        if c["expanded"][:64] != c["curve_secret"]:
            sys.exit(f"case {i}: the expanded secret does not start with the curve25519 secret")
        if c["signbit"] != int(c["ed_public"][62:64], 16) >> 7:
            sys.exit(f"case {i}: the sign bit is not the top bit of the public key")

    json.dump({
        "source": f"{root}/libtor.a via packages/tor/tools/prop228-probe.c",
        "message": MESSAGE.decode(),
        "cases": cases,
    }, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
