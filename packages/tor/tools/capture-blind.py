"""Pin key blinding's *service* half against tor's own `ed25519_keypair_blind`.

`hsblind.wac` derives the blinded public key, which is what a client needs, and that is already
pinned against a key tor published. This captures the blinded **secret**, which only a service uses:
it signs the descriptor's signing-key certificate with it.

Why it needs an oracle of its own. Nothing in a descriptor says which key signed it — tor verifies
the certificate against the key carried inside the certificate — so a wrong blinded secret produces
a document that decodes perfectly for anyone who does not know the identity key, and fails only for
the clients who matter. No descriptor-level check catches it. `tools/hsdesc-probe.c` accepts such a
descriptor happily; that is not a gap in the probe, it is what the format allows.

The signature is captured too, because a scalar that is wrong by a factor of the cofactor still looks
like a scalar: only signing with it and verifying against the blinded public key distinguishes them.

Needs a *built* tor source tree (`libtor.a` at its root).

    python3 packages/tor/tools/capture-blind.py > packages/tor/test/data/blind_vectors.json
"""
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile

DEFAULT_TOR = pathlib.Path.home() / "tor-build" / "torproject-tor-c8d2b17"
PROBE = pathlib.Path(__file__).with_name("blind-probe.c")


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


def clamp_factor(b):
    """The three masks tor's `ed25519_donna_gettweak` applies, which `blindingFactor` also applies."""
    b = bytearray(b)
    b[0] &= 248
    b[31] &= 63
    b[31] |= 64
    return bytes(b)


def main(argv):
    root = pathlib.Path(argv[0]) if argv else DEFAULT_TOR
    cases = []
    with tempfile.TemporaryDirectory() as tmp:
        probe = pathlib.Path(tmp) / "blprobe"
        build(root, probe)

        for i in range(4):
            # Deterministic, so re-running reproduces this file and a diff means tor changed.
            seed = hashlib.sha256(f"wac-mono blind vector {i} seed".encode()).digest()
            factor = clamp_factor(hashlib.sha3_256(f"wac-mono blind vector {i} factor".encode()).digest())
            r = subprocess.run([str(probe), seed.hex(), factor.hex()],
                               capture_output=True, text=True)
            if r.returncode != 0 or "OK" not in r.stdout:
                sys.exit(f"tor would not blind the key:\n{r.stdout}\n{r.stderr}")
            got = dict(line.split(": ", 1) for line in r.stdout.splitlines() if ": " in line)
            cases.append(dict(
                seed=seed.hex(),
                factor=factor.hex(),
                identitySecret=got["identity_secret"],
                identityPublic=got["identity_public"],
                blindedSecret=got["blinded_secret"],
                blindedPublic=got["blinded_public"],
                signature=got["signature"],
                message=got["message"],
            ))

    json.dump(dict(
        source="tor's own ed25519_keypair_blind and ed25519_sign, tor 0.4.7.13",
        produced_by="packages/tor/tools/capture-blind.py",
        note=("The blinded secret is the service half of key blinding. A wrong one yields a "
              "descriptor that decodes for anyone who does not know the identity key and fails only "
              "for clients who do, so no descriptor-level check finds it — which is why the values "
              "here come from tor rather than from a round trip through our own blinding."),
        cases=cases,
    ), sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main(sys.argv[1:])
