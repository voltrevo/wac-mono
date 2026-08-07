"""Pin INTRODUCE2 parsing against a cell **tor built**.

An INTRODUCE2 is byte-for-byte an INTRODUCE1, so this repo now has both ends of one format: a client
builder in `hsintro.wac` and a service parser in `hsservice.wac`. Testing one against the other is the
symmetric oracle that has caught this project out repeatedly — a builder and a parser sharing a
mistake agree perfectly.

So the cell here is written by tor's own `hs_cell_build_introduce1`, and the fixture records the
values tor was *given*. A parser that recovers those has agreed with an implementation that has never
seen ours.

That is not hypothetical for this cell. tor pads an INTRODUCE1 to a fixed size, and our client's
builder does not; a parser returning "the rest of the plaintext" as the link specifier list therefore
passed against our own builder and returned two hundred bytes of padding for tor's.

Needs a *built* tor source tree (`libtor.a` at its root).

    python3 packages/tor/tools/capture-introduce.py > packages/tor/test/data/introduce_vectors.json
"""
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile

DEFAULT_TOR = pathlib.Path.home() / "tor-build" / "torproject-tor-c8d2b17"
PROBE = pathlib.Path(__file__).with_name("introduce-probe.c")


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


def clamp(b):
    b = bytearray(b)
    b[0] &= 248
    b[31] = (b[31] & 127) | 64
    return bytes(b)


def x25519_public(secret):
    """Via openssl, not via a second curve25519 here — the same rule capture-hsntor.py follows."""
    der = bytes.fromhex("302e020100300506032b656e04220420") + secret
    r = subprocess.run(["openssl", "pkey", "-inform", "DER", "-pubout", "-outform", "DER"],
                       input=der, capture_output=True)
    if r.returncode != 0:
        sys.exit(f"openssl could not derive the public key: {r.stderr.decode()}")
    return r.stdout[-32:]


def main(argv):
    root = pathlib.Path(argv[0]) if argv else DEFAULT_TOR
    cases = []

    with tempfile.TemporaryDirectory() as tmp:
        probe = pathlib.Path(tmp) / "intprobe"
        build(root, probe)

        for i in range(3):
            # Deterministic, so re-running reproduces this file and a diff means tor changed.
            seed = f"wac-mono introduce vector {i}".encode()
            auth_pk = hashlib.sha256(seed + b" auth").digest()
            enc_sec = clamp(hashlib.sha256(seed + b" enc").digest())
            onion_sec = clamp(hashlib.sha256(seed + b" onion").digest())
            client_sec = clamp(hashlib.sha256(seed + b" client").digest())
            subcred = hashlib.sha3_256(seed + b" subcred").digest()
            cookie = hashlib.sha256(seed + b" cookie").digest()[:20]

            enc_pk = x25519_public(enc_sec)
            onion_pk = x25519_public(onion_sec)
            client_pk = x25519_public(client_sec)

            cell_path = pathlib.Path(tmp) / f"cell{i}.bin"
            r = subprocess.run([
                str(probe), "build", auth_pk.hex(), enc_pk.hex(), subcred.hex(),
                onion_pk.hex(), cookie.hex(), client_sec.hex(), str(cell_path),
            ], capture_output=True, text=True)
            if r.returncode != 0 or "BUILT" not in r.stdout:
                sys.exit(f"tor would not build the cell:\n{r.stdout}\n{r.stderr}")

            cell = cell_path.read_bytes()

            # The expected fields need no read-back: they are the values tor was *given*, so a
            # parser that recovers them has agreed with tor's writer. Asking tor to re-read its own
            # cell would have been a nice cross-check and is not available — `hs_cell_parse_introduce2`
            # asserts on a real circuit, which a stateless probe has not got. See the probe's header.
            cases.append(dict(
                introAuthKey=auth_pk.hex(),
                introEncSecret=enc_sec.hex(),
                introEncKey=enc_pk.hex(),
                subcredential=subcred.hex(),
                clientPublic=client_pk.hex(),
                rendCookie=cookie.hex(),
                rendOnionKey=onion_pk.hex(),
                # What the probe puts in every cell: the rendezvous point's address, its RSA
                # identity digest and its ed25519 identity — the list a real client sends, and the
                # one tor's own hs_get_extend_info_from_lspecs will accept. An address alone parses
                # and names a rendezvous point tor would decline to use.
                linkSpecifiers=("0300067f0000012329"
                                "0214" + "".join(f"{0xA0 + i:02x}" for i in range(20)) +
                                "0320" + "".join(f"{0x40 + i:02x}" for i in range(32))),
                cell=cell.hex(),
            ))

    json.dump(dict(
        source="tor's own hs_cell_build_introduce1, tor 0.4.7.13",
        produced_by="packages/tor/tools/capture-introduce.py",
        note=("Every cell here was written by tor. The expected fields are the values tor was "
              "given, so a parser that recovers them agrees with an implementation that has never "
              "seen ours. Note the padding: tor pads an INTRODUCE1 to a fixed size and our own "
              "client's builder does not, so a parser tested only against our builder returns the "
              "padding as part of the link specifier list. The reverse direction — tor reading one "
              "of our cells — is not here: hs_cell_parse_introduce2 asserts on a real circuit."),
        cases=cases,
    ), sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main(sys.argv[1:])
