#!/usr/bin/env python3
"""Capture a vote a chutney authority produced, with what is needed to check its signature.

A vote is self-verifying as a vector: it embeds the authority's key certificate, so the signing key
that made its `directory-signature` is inside the document. That means our digest computation can be
checked against tor's own signature with nothing else supplied.

Which is worth doing, because the span is not the one a reader would guess. tor hashes from
`network-status-version` to `\\ndirectory-signature` and then **to the following space** —
`router_get_hashes_impl(..., "network-status-version", "\\ndirectory-signature", ' ')`. A router
descriptor's RSA signature uses the same helper with `'\\n'`, so the two documents end their signed
spans differently: a descriptor includes the newline after its keyword, a network status includes only
the space. Both of the other plausible spans fail against a real vote.

    python3 packages/tor/tools/capture-vote.py [chutney-net-dir] > \\
        packages/tor/test/data/vote_vectors.json
"""
import base64
import glob
import json
import pathlib
import re
import sys

DEFAULT_NET = pathlib.Path.home() / "tor-build" / "chutney" / "net"


def main():
    net = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_NET
    votes = []
    for f in sorted(glob.glob(str(net / "*" / "*" / "v3-status-votes"))):
        try:
            text = pathlib.Path(f).read_text(errors="replace")
        except OSError:
            continue
        starts = [m.start() for m in re.finditer(r"(?m)^network-status-version ", text)]
        for i, start in enumerate(starts):
            end = starts[i + 1] if i + 1 < len(starts) else len(text)
            doc = text[start:end]
            key = re.search(
                r"(?m)^dir-signing-key\n-----BEGIN RSA PUBLIC KEY-----\n(.*?)"
                r"-----END RSA PUBLIC KEY-----\n", doc, re.S)
            sig = re.search(
                r"(?m)^directory-signature (\S+) (\S+)\n-----BEGIN SIGNATURE-----\n(.*?)"
                r"-----END SIGNATURE-----\n", doc, re.S)
            if not (key and sig):
                continue
            votes.append({
                "identityFingerprint": sig.group(1),
                "signingKeyFingerprint": sig.group(2),
                "signingKeyDer": base64.b64decode(key.group(1)).hex(),
                "signature": base64.b64decode(sig.group(3)).hex(),
                "vote": doc,
            })
        if votes:
            break

    if not votes:
        sys.exit(f"no vote with an embedded signing key found under {net}")

    json.dump({"source": str(net), "votes": votes[:1]}, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
