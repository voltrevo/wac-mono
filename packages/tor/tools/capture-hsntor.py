#!/usr/bin/env python3
"""Capture hs-ntor vectors from tor's own `test-hs-ntor-cl`.

The same shape as the ntor vectors in `test/data/ntor_vectors.json` and for the same reason: the
handshake has two halves that can be consistently wrong together, so the only check worth having is
against an implementation that is not ours.

`test-hs-ntor-cl` is built by `tools/tor.sh` and takes hex arguments:

    client1 <intro_auth_pubkey> <intro_enc_pubkey> <client_eph_seckey> <subcredential>
        -> ENC_KEY, MAC_KEY                     (the INTRODUCE1 cell's encryption keys)

    client2 <intro_auth_pubkey> <client_eph_seckey> <intro_enc_pubkey>
            <service_eph_rend_pubkey> <subcredential>
        -> AUTH_MAC, NTOR_KEY_SEED              (the RENDEZVOUS1 verification and key seed)

Deterministic given its inputs, so a recorded answer is as good as a live one — and unlike the plain
ntor case there is no fresh ephemeral key on tor's side of `client1`, so recorded and live values can
be compared directly.

    python3 packages/tor/tools/capture-hsntor.py > vectors.json
"""
import hashlib
import json
import os
import pathlib
import subprocess
import sys

PROG = pathlib.Path(os.environ.get(
    'TOR_HS_NTOR_CL',
    pathlib.Path.home() / 'tor-build/torproject-tor-c8d2b17/src/test/test-hs-ntor-cl'))


def run(*args):
    """Two 64-character hex lines, or exit.

    **The exit code is not usable here.** `test-hs-ntor-cl`'s `client2` ends with an unconditional
    `return 1` — read the source, it is a bug in tor's test harness rather than in the handshake, and
    `client1` right beside it returns properly. So success is judged by the output's shape.

    That is not the loose "grep the output and hope" it looks like: a failing run produces *no* lines,
    because every `printf` is after the early `goto done`. Requiring exactly two lines of exactly 64
    hex digits distinguishes the two cases completely, and anything else exits rather than being
    recorded as a vector.
    """
    return run_n(2, *args)


def run_n(want, *args):
    """`want` lines of 64 hex characters, or exit. See `run` for why the exit code is not used."""
    r = subprocess.run([str(PROG)] + [str(a) for a in args], capture_output=True)
    lines = [line.strip().lower() for line in r.stdout.decode().split() if line.strip()]
    if len(lines) != want or any(len(x) != 64 or not all(c in '0123456789abcdef' for c in x)
                                 for x in lines):
        sys.exit(f"{PROG} {args[0]} produced {lines!r}, not two 32-byte hex values"
                 f"{': ' + r.stderr.decode().strip() if r.stderr.strip() else ''}")
    return lines


def x25519_public(secret_hex):
    """The public key for a curve25519 secret, via openssl — not via a second implementation here."""
    # tor clamps the secret itself, so the raw 32 bytes are handed over as-is. openssl's raw X25519
    # import expects the clamped form, which is what tor stores, so this agrees.
    import subprocess as sp
    der_prefix = bytes.fromhex('302e020100300506032b656e04220420')
    key = der_prefix + bytes.fromhex(secret_hex)
    r = sp.run(['openssl', 'pkey', '-inform', 'DER', '-pubout', '-outform', 'DER'],
               input=key, capture_output=True)
    if r.returncode != 0:
        sys.exit(f"openssl could not derive the public key: {r.stderr.decode()}")
    return r.stdout[-32:].hex()


def main():
    if not PROG.is_file():
        sys.exit(f"{PROG} not found — build it with `make src/test/test-hs-ntor-cl` in tor's tree, "
                 f"or set TOR_HS_NTOR_CL")

    cases = []
    for i in range(4):
        # Deterministic inputs, so re-running this reproduces the file exactly and a diff means
        # something changed in tor rather than in the dice.
        seed = f"wac-mono hs-ntor vector {i}".encode()
        auth_pub = hashlib.sha256(seed + b" auth").hexdigest()
        enc_sec = bytearray(hashlib.sha256(seed + b" enc").digest())
        enc_sec[0] &= 248
        enc_sec[31] = (enc_sec[31] & 127) | 64
        client_sec = bytearray(hashlib.sha256(seed + b" client").digest())
        client_sec[0] &= 248
        client_sec[31] = (client_sec[31] & 127) | 64
        service_sec = bytearray(hashlib.sha256(seed + b" service").digest())
        service_sec[0] &= 248
        service_sec[31] = (service_sec[31] & 127) | 64
        subcred = hashlib.sha3_256(seed + b" subcred").hexdigest()

        enc_pub = x25519_public(bytes(enc_sec).hex())
        client_pub = x25519_public(bytes(client_sec).hex())
        service_pub = x25519_public(bytes(service_sec).hex())

        enc_key, mac_key = run('client1', auth_pub, enc_pub, bytes(client_sec).hex(), subcred)
        # The service's side of the same two keys. `server1` also emits rendezvous values, but its
        # ephemeral keypair is generated inside the tool, so only the first two lines are reproducible
        # — the rest are recorded as nothing and would be a vector that changes every run.
        s_enc_key, s_mac_key, _authmac, _seed, _y = run_n(
            5, 'server1', auth_pub, bytes(enc_sec).hex(), client_pub, subcred)
        # tor's own statement that the two sides agree. If this ever differed, one of the two
        # derivations in tor would be wrong and no test of ours could be trusted either way.
        if (s_enc_key, s_mac_key) != (enc_key, mac_key):
            sys.exit("tor's client and service disagree about the INTRODUCE1 keys, which cannot "
                     "happen — check the tool's arguments before trusting anything here")
        auth_mac, key_seed = run('client2', auth_pub, bytes(client_sec).hex(), enc_pub,
                                 service_pub, subcred)
        cases.append(dict(
            introAuthKey=auth_pub,
            introEncKey=enc_pub,
            introEncSecret=bytes(enc_sec).hex(),
            clientEphemeralSecret=bytes(client_sec).hex(),
            clientEphemeralPublic=client_pub,
            serviceEphemeralPublic=service_pub,
            serviceEphemeralSecret=bytes(service_sec).hex(),
            subcredential=subcred,
            encKey=enc_key,
            macKey=mac_key,
            authMac=auth_mac,
            ntorKeySeed=key_seed,
        ))

    json.dump(dict(
        source="tor's own src/test/test-hs-ntor-cl, tor 0.4.7.13",
        produced_by="packages/tor/tools/capture-hsntor.py",
        protoid="tor-hs-ntor-curve25519-sha3-256-1",
        note=("Every expected value is tor's. Inputs are derived deterministically from a fixed "
              "string, so re-running reproduces this file byte for byte and a difference means tor "
              "changed. Public keys come from `openssl pkey`, not from a second curve25519 here."),
        cases=cases,
    ), sys.stdout, indent=2)
    print(file=sys.stdout)
    print(f"{len(cases)} hs-ntor cases", file=sys.stderr)


if __name__ == '__main__':
    main()
