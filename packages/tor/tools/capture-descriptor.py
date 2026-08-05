#!/usr/bin/env python3
"""Capture a v3 onion service descriptor, and what it decrypts to, from a running chutney network.

The descriptor itself is tor's: fetched by a tor client over its own circuits and read back with
`GETINFO hs/client/desc/id/<addr>` on the control port. The expected plaintexts are derived here with
`hashlib` and `openssl enc`, so nothing in the vector has been through the wac implementation that the
vector exists to test.

Two layers of encryption, both using the same scheme (rend-spec-v3 §2.5.3) with different customisation:

    layer 1 (`superencrypted`):  SECRET_DATA = blinded_key,  STRING_CONSTANT = "hsdir-superencrypted-data"
    layer 2 (`encrypted`):       SECRET_DATA = blinded_key,  STRING_CONSTANT = "hsdir-encrypted-data"

    secret_input = SECRET_DATA | N_hs_subcred | INT_8(revision_counter)
    keys         = SHAKE-256(secret_input | salt | STRING_CONSTANT, 32 + 16 + 32)
    MAC          = SHA3-256(INT_8(len(mac_key)) | mac_key | INT_8(len(salt)) | salt | ciphertext)

The MAC is what makes this vector self-checking: it is verified here before anything is written, so a
descriptor that was captured wrong cannot become an expected value.

    python3 packages/tor/tools/capture-descriptor.py [chutney-net-nodes-dir] > vectors.json

Needs `openssl` on PATH for AES-256-CTR — deliberately not a Python AES, since the point of a vector
is that it did not come from a second implementation of ours.
"""
import base64
import binascii
import hashlib
import json
import pathlib
import re
import socket
import struct
import subprocess
import sys
import tempfile

S_KEY_LEN, S_IV_LEN, MAC_KEY_LEN = 32, 16, 32


def control(port, cookie_path, command):
    cookie = pathlib.Path(cookie_path).read_bytes()
    s = socket.create_connection(('127.0.0.1', port))
    f = s.makefile('rw', encoding='latin-1', newline='\r\n')

    def send(line):
        f.write(line + '\r\n')
        f.flush()
        out = []
        while True:
            got = f.readline().rstrip('\r\n')
            out.append(got)
            if len(got) >= 4 and got[3] == ' ':
                break
        return out

    send('AUTHENTICATE ' + binascii.hexlify(cookie).decode())
    reply = send(command)
    s.close()
    return reply


def pem(body, label, text):
    m = re.search(rf'{label}\n-----BEGIN {body}-----\n(.*?)-----END {body}-----', text, re.S)
    return base64.b64decode(m.group(1)) if m else None


def cert_signing_key(cert):
    """Extension type 4, `signed-with-ed25519-key` — the blinded key, for a type-08 descriptor cert."""
    at, out = 40, None
    for _ in range(cert[39]):
        length = int.from_bytes(cert[at:at + 2], 'big')
        if cert[at + 2] == 4:
            out = cert[at + 4:at + 4 + length]
        at += 4 + length
    return out


def aes256ctr(key, iv, data):
    with tempfile.NamedTemporaryFile() as src, tempfile.NamedTemporaryFile() as dst:
        src.write(data)
        src.flush()
        r = subprocess.run(
            ['openssl', 'enc', '-d', '-aes-256-ctr', '-K', key.hex(), '-iv', iv.hex(),
             '-in', src.name, '-out', dst.name],
            capture_output=True)
        if r.returncode != 0:
            sys.exit(f"openssl failed: {r.stderr.decode()}")
        return pathlib.Path(dst.name).read_bytes()


def decrypt_layer(blob, secret_data, subcred, revision, constant):
    """Returns (plaintext, salt, key, iv, mac_key). Fails loudly if the MAC does not check."""
    salt, ciphertext, mac = blob[:16], blob[16:-32], blob[-32:]
    secret_input = secret_data + subcred + struct.pack('>Q', revision)
    keys = hashlib.shake_256(secret_input + salt + constant).digest(S_KEY_LEN + S_IV_LEN + MAC_KEY_LEN)
    key, iv, mac_key = keys[:S_KEY_LEN], keys[S_KEY_LEN:S_KEY_LEN + S_IV_LEN], keys[S_KEY_LEN + S_IV_LEN:]
    want = hashlib.sha3_256(struct.pack('>Q', len(mac_key)) + mac_key
                            + struct.pack('>Q', len(salt)) + salt + ciphertext).digest()
    if want != mac:
        sys.exit(f"MAC mismatch on the {constant.decode()} layer — the capture is wrong, not the code")
    return aes256ctr(key, iv, ciphertext), salt, key, iv, mac_key


def main(nodes_dir):
    nodes = pathlib.Path(nodes_dir)
    hs = next((d for d in sorted(nodes.iterdir()) if d.name.endswith('h')), None)
    client = next((d for d in sorted(nodes.iterdir()) if d.name.endswith('c')), None)
    if hs is None or client is None:
        sys.exit("need a hidden-service node (…h) and a client node (…c)")

    onion = (hs / 'hidden_service' / 'hostname').read_text().strip()
    address = onion.replace('.onion', '')
    port = int(re.search(r'^ControlPort (\d+)', (client / 'torrc').read_text(), re.M).group(1))

    reply = control(port, client / 'control_auth_cookie', f'GETINFO hs/client/desc/id/{address}')
    if not reply[0].startswith('250+'):
        sys.exit(f"the client has no cached descriptor ({reply[0]}); fetch through it first, e.g.\n"
                 f"  curl --socks5-hostname 127.0.0.1:<socksport> http://{onion}:5858/")
    descriptor = '\n'.join(reply[1:-2])          # drop the 250+ header, the '.' and the '250 OK'

    raw = base64.b32decode(address.upper() + '=' * ((8 - len(address) % 8) % 8))
    identity = raw[:32]
    cert = pem('ED25519 CERT', 'descriptor-signing-key-cert', descriptor)
    blinded = cert_signing_key(cert)
    signing_key = cert[7:39]
    revision = int(re.search(r'^revision-counter (\d+)', descriptor, re.M).group(1))

    credential = hashlib.sha3_256(b"credential" + identity).digest()
    subcred = hashlib.sha3_256(b"subcredential" + credential + blinded).digest()

    outer = pem('MESSAGE', 'superencrypted', descriptor)
    first, salt1, key1, iv1, mac1 = decrypt_layer(
        outer, blinded, subcred, revision, b"hsdir-superencrypted-data")
    first_text = first.rstrip(b'\x00').decode('latin-1')

    inner = pem('MESSAGE', 'encrypted', first_text)
    second, salt2, key2, iv2, mac2 = decrypt_layer(
        inner, blinded, subcred, revision, b"hsdir-encrypted-data")
    second_text = second.rstrip(b'\x00').decode('latin-1')

    intro = re.findall(r'^introduction-point (\S+)$', second_text, re.M)
    onion_keys = re.findall(r'^onion-key ntor (\S+)$', second_text, re.M)
    enc_keys = re.findall(r'^enc-key ntor (\S+)$', second_text, re.M)
    if not intro:
        sys.exit("no introduction points in the decrypted descriptor; something is wrong")

    json.dump(dict(
        source="tor 0.4.7.13 on a local chutney hs-v3 network",
        produced_by="packages/tor/tools/capture-descriptor.py",
        note=("The descriptor is tor's, fetched by a tor client over its own circuits. The expected "
              "plaintexts are derived here with hashlib and `openssl enc`, so nothing in this vector "
              "came from the implementation it tests. Both layer MACs were verified before writing."),
        onion=onion,
        identityKey=identity.hex(),
        blindedKey=blinded.hex(),
        descriptorSigningKey=signing_key.hex(),
        subcredential=subcred.hex(),
        revisionCounter=revision,
        descriptor=descriptor,
        layers=[
            dict(name="superencrypted", constant="hsdir-superencrypted-data",
                 salt=salt1.hex(), secretKey=key1.hex(), secretIv=iv1.hex(), macKey=mac1.hex(),
                 plaintextSha3=hashlib.sha3_256(first).hexdigest(),
                 plaintextLength=len(first),
                 plaintextPrefix=first_text[:200]),
            dict(name="encrypted", constant="hsdir-encrypted-data",
                 salt=salt2.hex(), secretKey=key2.hex(), secretIv=iv2.hex(), macKey=mac2.hex(),
                 plaintextSha3=hashlib.sha3_256(second).hexdigest(),
                 plaintextLength=len(second),
                 plaintextPrefix=second_text[:200]),
        ],
        introductionPoints=[
            dict(linkSpecifiers=ls, onionKeyNtor=ok, encKeyNtor=ek)
            for ls, ok, ek in zip(intro, onion_keys, enc_keys)
        ],
    ), sys.stdout, indent=2)
    print(file=sys.stdout)
    print(f"{len(intro)} introduction points, descriptor {len(descriptor)} bytes", file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1
         else str(pathlib.Path.home() / 'agent-b/workspaces/chutney/net/nodes'))
