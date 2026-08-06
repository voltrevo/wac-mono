"""Pin microdescriptors and their digests against tor's own parser.

A microdescriptor's verdict is its **digest**, not whether it parses — `microdescs_parse_from_string`
accepts a document whose ntor key, RSA key or line order has been corrupted, and only the digest
changes. So this captures the digest tor computes for each case, and the wac test compares against
that rather than against a boolean.

The input descriptors are the ones `src/gendesc.wac` writes, so the fixture is our own generator's
output put through tor's parser — which is the seam that matters. Needs a *built* tor source tree
(`libtor.a` at its root) and at least one descriptor.

    python3 packages/tor/tools/capture-microdesc.py <descriptor>... [--tor <dir>] > \
        packages/tor/test/data/microdesc_vectors.json
"""
import json
import pathlib
import re
import subprocess
import sys
import tempfile

DEFAULT_TOR = pathlib.Path.home() / "tor-build" / "torproject-tor-c8d2b17"
PROBE = pathlib.Path(__file__).with_name("microdesc-probe.c")


def build(root, out):
    cmd = [
        "gcc", "-O1", "-o", str(out), str(PROBE),
        f"-I{root}", f"-I{root}/src", f"-I{root}/src/ext", f"-I{root}/src/ext/trunnel",
        str(root / "libtor.a"),
        "-lssl", "-lcrypto", "-lz", "-lm", "-levent", "-lpthread",
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"compiling the probe failed:\n{r.stderr}")


def ask(probe, text):
    """tor's verdict and digest for one microdescriptor."""
    r = subprocess.run([str(probe)], input=text, capture_output=True, text=True)
    out = {"accepted": r.returncode == 0}
    for line in r.stdout.splitlines():
        if ": " in line:
            k, v = line.split(": ", 1)
            out[k] = v
    return out


def microdescriptor(descriptor, policy_summary):
    """The document `dirvote_create_microdescriptor` would produce, in its order.

    Kept in Python as well as in wac on purpose: the point of the fixture is that the bytes were
    accepted and digested by tor, so this side only has to *offer* a candidate. If the wac
    implementation and this one disagree, the digest comparison in the test is what says so.
    """
    onion = re.search(
        r"^onion-key\n(-----BEGIN RSA PUBLIC KEY-----\n.*?-----END RSA PUBLIC KEY-----\n)",
        descriptor, re.S | re.M)
    ntor = re.search(r"^ntor-onion-key (\S+)", descriptor, re.M)
    master = re.search(r"^master-key-ed25519 (\S+)", descriptor, re.M)
    if not (onion and ntor and master):
        sys.exit("the descriptor is missing onion-key, ntor-onion-key or master-key-ed25519")
    body = f"onion-key\n{onion.group(1)}ntor-onion-key {ntor.group(1)}\n"
    if policy_summary and policy_summary != "reject 1-65535":
        body += f"p {policy_summary}\n"
    body += f"id ed25519 {master.group(1)}\n"
    return body


def main(argv):
    root = DEFAULT_TOR
    paths = []
    i = 0
    while i < len(argv):
        if argv[i] == "--tor":
            root = pathlib.Path(argv[i + 1])
            i += 2
            continue
        paths.append(pathlib.Path(argv[i]))
        i += 1
    if not paths:
        sys.exit(__doc__)

    with tempfile.TemporaryDirectory() as tmp:
        probe = pathlib.Path(tmp) / "mdprobe"
        build(root, probe)

        cases = []
        for p in paths:
            descriptor = p.read_text()
            # Both policies, because the `p` line is present for one and absent for the other — and
            # "absent" is a case a generator gets wrong by writing `p reject 1-65535` instead.
            for summary in ("accept 1-65535", "reject 1-65535"):
                body = microdescriptor(descriptor, summary)
                verdict = ask(probe, body)
                if not verdict["accepted"]:
                    sys.exit(f"tor rejected the microdescriptor for {p} ({summary})")
                cases.append({
                    "name": f"{p.name} {summary}",
                    "descriptor": descriptor,
                    "policySummary": summary,
                    "microdescriptor": body,
                    "digest256Base64": verdict["digest256_base64"],
                    "ntorOnionKey": verdict["ntor_onion_key"],
                    "ed25519Id": verdict["ed25519_id"],
                })

        # The mutations, to record what a verdict is worth. Each is offered to tor and its digest
        # kept; the wac test asserts the digests differ from the unmodified one, which is the only
        # thing that makes the digest a check rather than a decoration.
        base = cases[0]["microdescriptor"]
        mutations = {
            "id line removed": "".join(
                l + "\n" for l in base.splitlines() if not l.startswith("id ")),
            "ntor key altered": base.replace("ntor-onion-key ", "ntor-onion-key ", 1).replace(
                base.split("ntor-onion-key ")[1][0], "z", 1),
            "trailing newline dropped": base.rstrip("\n"),
        }
        mutated = []
        for name, text in mutations.items():
            v = ask(probe, text)
            mutated.append({
                "name": name,
                "microdescriptor": text,
                "accepted": v["accepted"],
                "digest256Base64": v.get("digest256_base64", ""),
            })

    json.dump({"cases": cases, "mutations": mutated}, sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main(sys.argv[1:])
