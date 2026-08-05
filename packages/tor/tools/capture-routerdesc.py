#!/usr/bin/env python3
"""Capture router descriptors from tor's own test data.

The source is `src/test/test_descriptors.inc` in a tor checkout — C string literals holding
descriptors that a real tor produced and that tor's own parser is tested against. That makes them a
better oracle than anything a chutney network gives us for this particular job, because they are
committed, stable, and small enough to keep as a vector rather than regenerate.

What they settle is **proposal 228**, the curve25519 -> ed25519 conversion behind
`ntor-onion-key-crosscert`. Every input is C tor's:

    ntor-onion-key                  the curve25519 public key, base64
    ntor-onion-key-crosscert <bit>  the sign bit, which is not recoverable from the key
    -----BEGIN ED25519 CERT-----    a certificate signed by the *converted* key
    master-key-ed25519              the identity the certificate certifies

So converting the onion key with the stated bit and verifying the certificate under the result tests
the conversion against tor and nothing else. A round trip of our own could not: we would convert a key
we derived ourselves and check a certificate we signed ourselves, which agrees with itself whatever
the formula is.

The descriptor text is kept whole as well, so tests of the signature digests
(`router-sig-ed25519`, `router-signature`) need no second capture.

    python3 packages/tor/tools/capture-routerdesc.py [tor-source-dir] > \
        packages/tor/test/data/routerdesc_vectors.json
"""
import base64
import json
import pathlib
import re
import sys

DEFAULT_TOR = pathlib.Path.home() / "tor-build" / "torproject-tor-c8d2b17"


def unquote_c(text):
    """Recover the payload of a run of C string literals."""
    parts = re.findall(r'"((?:[^"\\]|\\.)*)"', text)
    return "".join(parts).encode("latin-1").decode("unicode_escape")


def b64_hex(s):
    """tor writes these keys unpadded; base64.b64decode insists on the padding."""
    return base64.b64decode(s + "=" * (-len(s) % 4)).hex()


def pem_hex(block):
    return base64.b64decode("".join(block)).hex()


SIGNATURE_END = "-----END SIGNATURE-----\n"


def descriptors(text):
    """Each descriptor, from its `router` line to the end of its signature block.

    Not "up to the next `router` line": tor's cache format puts *annotations* (`@uploaded-at`,
    `@source`) before each descriptor, so slicing that way appends the next descriptor's annotations
    to this one. `router_parse_entry_from_string` refuses the result unless annotations are explicitly
    allowed — which is how this was found, by feeding a descriptor tor wrote back to tor's own parser
    and having it rejected.
    """
    for m in re.finditer(r"(?m)^router ", text):
        end = text.find(SIGNATURE_END, m.start())
        if end < 0:
            continue
        yield text[m.start():end + len(SIGNATURE_END)]


def field(desc, keyword):
    m = re.search(rf"(?m)^{re.escape(keyword)} (.+)$", desc)
    return m.group(1).strip() if m else None


def pem_after(desc, keyword, label):
    """The PEM block that follows `keyword`, as hex."""
    m = re.search(
        rf"(?m)^{re.escape(keyword)}[^\n]*\n-----BEGIN {label}-----\n(.*?)-----END {label}-----",
        desc,
        re.S,
    )
    if not m:
        return None
    return pem_hex(m.group(1).split())


def main():
    root = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_TOR
    inc = root / "src" / "test" / "test_descriptors.inc"
    if not inc.exists():
        sys.exit(f"{inc}: not found — pass the path to a tor source tree")

    text = unquote_c(inc.read_text())

    out = []
    for desc in descriptors(text):
        nickname = desc.split()[1]
        ntor = field(desc, "ntor-onion-key")
        crosscert_line = field(desc, "ntor-onion-key-crosscert")
        master = field(desc, "master-key-ed25519")
        cert = pem_after(desc, "ntor-onion-key-crosscert", "ED25519 CERT")
        if not (ntor and crosscert_line and master and cert):
            continue

        signbit = int(crosscert_line.split()[0])
        if signbit not in (0, 1):
            sys.exit(f"{nickname}: sign bit is {signbit!r}")

        # The certificate must certify the master key, or the vector is mismatched and the test
        # built on it would be checking two unrelated relays against each other.
        certified = cert[14:78]
        if certified != b64_hex(master):
            sys.exit(f"{nickname}: crosscert certifies {certified}, not the master key")

        out.append({
            "nickname": nickname,
            "ntor_onion_key": b64_hex(ntor),
            "signbit": signbit,
            "ntor_crosscert": cert,
            "master_key_ed25519": b64_hex(master),
            "identity_ed25519_cert": pem_after(desc, "identity-ed25519", "ED25519 CERT"),
            "onion_key_crosscert": pem_after(desc, "onion-key-crosscert", "CROSSCERT"),
            "router_sig_ed25519": field(desc, "router-sig-ed25519"),
            "descriptor": desc,
        })

    if not out:
        sys.exit("no descriptor carried all of the fields needed")

    json.dump({"source": str(inc), "descriptors": out}, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
