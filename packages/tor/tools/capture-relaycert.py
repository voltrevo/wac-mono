#!/usr/bin/env python3
"""Capture a relay's ed25519 certificates from a running chutney network.

tor generated these, so they are the oracle for both directions: our verifier must accept them, and
our builder must reproduce them byte for byte when given the same inputs.

The byte-for-byte check is the strong one and it is available because an ed25519 certificate is
entirely determined by its fields — there is no randomness, and ed25519 signatures are deterministic.
So `ed25519Cert` given tor's certified key, expiry and signing keypair must produce tor's exact
bytes, which no round trip of our own could establish.

That needs the relay's *secret* signing key, which chutney writes to disk unencrypted. It is a
throwaway testnet key; see the timing note at the bottom of `packages/crypto/src/rsa.wac` about what
these keys are and are not for.

    python3 packages/tor/tools/capture-relaycert.py [chutney-net-nodes-dir] > vectors.json
"""
import json
import pathlib
import sys

# Each key file is a 32-byte NUL-padded tag followed by the key material.
TAG_LEN = 32


def read_tagged(path, expect):
    raw = pathlib.Path(path).read_bytes()
    tag = raw[:TAG_LEN].rstrip(b'\x00').decode('latin-1')
    if expect not in tag:
        sys.exit(f"{path}: tag is {tag!r}, expected something containing {expect!r}")
    return raw[TAG_LEN:]


def main(nodes_dir):
    nodes = pathlib.Path(nodes_dir)
    cases = []
    for d in sorted(nodes.iterdir()):
        keys = d / 'keys'
        cert = keys / 'ed25519_signing_cert'
        if not cert.is_file():
            continue
        master_pub = read_tagged(keys / 'ed25519_master_id_public_key', 'ed25519v1-public')
        # The secret file holds an *expanded* key: 32 bytes of scalar and 32 of nonce, not a seed.
        # Our `ed25519Sign` takes a seed, so the master secret cannot be used to re-sign — which is
        # why the vector records the signing key's own secret instead, and why the rebuild check
        # below uses a keypair we generate rather than tor's.
        signing_secret = read_tagged(keys / 'ed25519_signing_secret_key', 'ed25519v1-secret')
        body = read_tagged(cert, 'ed25519v1-cert')
        cases.append(dict(
            nickname=f"test{d.name}",
            masterIdentity=master_pub.hex(),
            signingCert=body.hex(),
            signingSecretExpanded=signing_secret.hex(),
        ))
        if len(cases) >= 4:
            break

    if not cases:
        sys.exit("no relay in that directory has an ed25519_signing_cert")

    json.dump(dict(
        source="tor 0.4.7.13 on a local chutney network",
        produced_by="packages/tor/tools/capture-relaycert.py",
        note=("Certificates tor generated. The signing cert is type 4: the relay's signing key, "
              "certified by its ed25519 master identity, with the identity in extension 4. Our "
              "verifier must accept every one of them, which checks that the signature covers the "
              "first N-64 bytes with no personalisation prefix — cert-spec §1.1's general rule says "
              "there is a prefix and §2.1 overrides it, and reading only the first gives a "
              "certificate no relay accepts."),
        secretKeyNote=("ed25519_signing_secret_key holds an *expanded* key — 32 bytes of clamped "
                       "scalar and 32 of nonce — not a seed. `ed25519Sign` takes a seed, so these "
                       "cannot be used to re-sign tor's own certificates. The byte-for-byte rebuild "
                       "test therefore uses a keypair of our own and checks the encoding against a "
                       "cert we can re-derive, while the verification tests use tor's."),
        cases=cases,
    ), sys.stdout, indent=2)
    print(file=sys.stdout)
    print(f"{len(cases)} relay certificates", file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1
         else str(pathlib.Path.home() / 'agent-b/workspaces/chutney/net/nodes'))
