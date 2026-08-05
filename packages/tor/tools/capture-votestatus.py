#!/usr/bin/env python3
"""Capture router status entries from a chutney network's own votes.

A vote's `r` line is an authority's summary of one relay, and every field of it is derivable from that
relay's descriptor. So a chutney network gives us both halves of a differential for free: the
descriptor C tor published, and the `r` line C tor's authority wrote about it. Reproducing the second
from the first is the test.

The pairing is by descriptor digest, which is the `r` line's third field, and **that digest is not a
hash of the whole descriptor.** It is SHA-1 over the span the RSA `router-signature` covers — from
`router ` through `router-signature\\n` inclusive, stopping before the signature block itself. Hashing
the whole document produces a perfectly well-formed 20 bytes that no authority agrees with, and the
only reason this script pairs anything at all is that tor was asked which span it meant:
`parsedesc-probe.c` prints `ri->cache_info.signed_descriptor_digest`, and matching it settled the
question. With the wrong span, zero of five entries paired.

The descriptors and votes are read out of a chutney `net/nodes*` directory, which is shared and
read-only as far as this script is concerned.

    python3 packages/tor/tools/capture-votestatus.py [chutney-net-dir] > \\
        packages/tor/test/data/votestatus_vectors.json
"""
import base64
import glob
import hashlib
import json
import pathlib
import re
import sys

DEFAULT_NET = pathlib.Path.home() / "tor-build" / "chutney" / "net"
SIGNATURE_SPAN = "router-signature\n"
DESC_END = "-----END SIGNATURE-----\n"

# `r nickname identity digest publication IP ORPort DirPort`
R_LINE = re.compile(r"(?m)^r (\S+) (\S+) (\S+) (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) (\S+) (\d+) (\d+)$")


def unpadded(b):
    return base64.b64encode(b).decode().rstrip("=")


def descriptors(net):
    """Every descriptor any node cached, keyed by the digest an `r` line would carry."""
    out = {}
    for f in glob.glob(str(net / "*" / "*" / "cached-descriptors*")):
        try:
            text = pathlib.Path(f).read_text(errors="replace")
        except OSError:
            continue
        for m in re.finditer(r"(?m)^router ", text):
            end = text.find(DESC_END, m.start())
            if end < 0:
                continue
            body = text[m.start():end + len(DESC_END)]
            if SIGNATURE_SPAN not in body:
                continue
            cut = body.index(SIGNATURE_SPAN) + len(SIGNATURE_SPAN)
            out[unpadded(hashlib.sha1(body[:cut].encode()).digest())] = body
    return out


def rlines(net):
    """Every `r` line any authority wrote, keyed by the same digest."""
    out = {}
    for f in glob.glob(str(net / "*" / "*" / "v3-status-votes")) + \
            glob.glob(str(net / "*" / "*" / "cached-consensus")):
        try:
            text = pathlib.Path(f).read_text(errors="replace")
        except OSError:
            continue
        for m in R_LINE.finditer(text):
            out.setdefault(m.group(3), m)
    return out


def main():
    net = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_NET
    if not net.is_dir():
        sys.exit(f"{net}: not a directory — pass a chutney net directory")

    descs, lines = descriptors(net), rlines(net)
    paired = sorted(set(descs) & set(lines))
    if not paired:
        sys.exit(
            f"no descriptor paired with an r line ({len(descs)} descriptors, {len(lines)} r lines).\n"
            "If both counts are non-zero the digest span is wrong — see this script's docstring."
        )

    cases = []
    for digest in paired:
        m = lines[digest]
        body = descs[digest]
        # The identity digest is the r line's second field, and it is SHA-1 of the DER RSAPublicKey
        # identity — the same value a descriptor writes as `fingerprint`, in a different encoding.
        # Checking it here means the vector cannot pair a descriptor with another relay's r line.
        fp = re.search(r"(?m)^fingerprint (.+)$", body)
        if not fp:
            sys.exit(f"{m.group(1)}: descriptor has no fingerprint line")
        want = unpadded(bytes.fromhex(fp.group(1).replace(" ", "")))
        if want != m.group(2):
            sys.exit(f"{m.group(1)}: r line identity {m.group(2)} is not the descriptor's {want}")
        cases.append({
            "nickname": m.group(1),
            "identity": m.group(2),
            "digest": m.group(3),
            "publication": m.group(4),
            "address": m.group(5),
            "orPort": int(m.group(6)),
            "dirPort": int(m.group(7)),
            "rLine": m.group(0),
            "descriptor": body,
        })

    json.dump({"source": str(net), "cases": cases}, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
