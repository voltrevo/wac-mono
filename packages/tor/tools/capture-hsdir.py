#!/usr/bin/env python3
"""Capture an HSDir-hashring vector from a running chutney hs-v3 network.

Everything in the output is tor's, observed rather than computed here:

  * the blinded key and the per-relay hash-ring index come from the service's own `info.log`, which
    logs one line per upload naming the HSDir, its ed25519 identity and the index it computed;
  * the shared random values and the consensus timings come from the client's cached consensus;
  * the candidate relay set and their ed25519 identities come from each node's own key file.

Capturing rather than computing is the point. The hash ring has no local oracle: a client that gets
an index wrong asks the wrong directory, which answers 404 — the same answer as a service that never
published. The only thing that knows the right answer is tor.

The one value derived here is the time period, and it is derived by *search*: the period that makes
tor's recorded indices reproduce. A vector whose indices cannot be reproduced from a recorded SRV is
dropped rather than emitted, because a vector nobody has reproduced once may be recording a typo.
chutney rotates shared random values every few minutes, so uploads older than the consensus's two
recorded values are expected to be dropped.

Run against a live network:

    python3 packages/tor/tools/capture-hsdir.py [chutney-net-nodes-dir] > vectors.json

Standing one up is in `packages/tor/README.md`. The vector it produces is committed, so nothing in
the test suite needs a network.
"""
import base64
import calendar
import collections
import hashlib
import json
import pathlib
import re
import sys
import time as _time

REPLICAS = (1, 2)                     # hsdir_n_replicas, default 2
SHARED_RANDOM_N_ROUNDS = 12
SHARED_RANDOM_N_PHASES = 2

UPLOAD_RE = re.compile(
    r'upload_descriptor_to_hsdir\(\): Service (\S+) (\S+) descriptor of revision \d+ '
    r'initiated upload request to \$([0-9A-F]+)~(\S+) \[([A-Za-z0-9+/]{43})\] '
    r'at \S+ with index ([0-9A-F]+) \(([0-9A-F]+)\)')


def parse_uploads(log_text):
    """(ed25519, blinded key) -> what tor logged for that upload."""
    out = {}
    for m in UPLOAD_RE.finditer(log_text):
        onion, which, fingerprint, nickname, ed_b64, index, blinded = m.groups()
        ed = base64.b64decode(ed_b64 + '=').hex()
        out[(ed, blinded.lower())] = dict(
            onion=onion, which=which, nickname=nickname, rsaFingerprint=fingerprint,
            ed25519=ed, relayIndex=index.lower(), blindedKey=blinded.lower())
    return out


def relay_index(ed_hex, srv, period_num, period_length):
    """`H("node-idx" | node_identity | shared_random_value | INT_8(tp) | INT_8(period_length))`."""
    return hashlib.sha3_256(
        b"node-idx" + bytes.fromhex(ed_hex) + srv
        + period_num.to_bytes(8, 'big') + period_length.to_bytes(8, 'big')).hexdigest()


def service_index(blinded_hex, replica, period_length, period_num):
    """`H("store-at-idx" | blinded_public_key | INT_8(replica) | INT_8(len) | INT_8(tp))`.

    Note the field order: replica, then **length, then number** — the reverse of `node-idx`'s
    trailing pair. That is what the specification says and it is easy to normalise away by accident.
    """
    return hashlib.sha3_256(
        b"store-at-idx" + bytes.fromhex(blinded_hex)
        + replica.to_bytes(8, 'big') + period_length.to_bytes(8, 'big')
        + period_num.to_bytes(8, 'big')).hexdigest()


def utc(stamp):
    return calendar.timegm(_time.strptime(stamp, '%Y-%m-%d %H:%M:%S'))


def main(nodes_dir):
    nodes = pathlib.Path(nodes_dir)
    if not nodes.is_dir():
        sys.exit(f"{nodes} is not a directory; pass a chutney net/nodes path")
    hs = next((d for d in sorted(nodes.iterdir()) if d.name.endswith('h')), None)
    client = next((d for d in sorted(nodes.iterdir()) if d.name.endswith('c')), None)
    if hs is None or client is None:
        sys.exit("need both a hidden-service node (…h) and a client node (…c)")

    consensus = (client / 'cached-microdesc-consensus').read_text()
    srvs = {k: base64.b64decode(v)
            for k, v in re.findall(r'shared-rand-(\w+)-value \d+ (\S+)', consensus)}
    if not srvs:
        sys.exit("no shared random values in the consensus; the network is too young")
    times = dict(re.findall(r'^(valid-after|fresh-until) (.+)$', consensus, re.M))

    uploads = parse_uploads((hs / 'info.log').read_text(errors='replace'))
    if not uploads:
        sys.exit("no upload lines in the service log; it needs `Log info file` and a published desc")

    # Which nicknames the consensus gives the HSDir flag. That is the candidate set the ring is
    # drawn from, and it is not the same as "every node with an identity key": a client has none, and
    # a relay can be in the consensus without the flag.
    hsdir_flagged = set()
    for entry in re.finditer(r'^r (\S+) .*?^s ([^\n]*)$', consensus, re.M | re.S):
        if 'HSDir' in entry.group(2).split():
            hsdir_flagged.add(entry.group(1))

    # Each relay's ed25519 identity from its own key file: a 32-byte
    # "== ed25519v1-master-id-public ==" tag followed by the key.
    relays = []
    for d in sorted(nodes.iterdir()):
        key = d / 'keys' / 'ed25519_master_id_public_key'
        if key.is_file():
            nickname = f"test{d.name}"
            relays.append(dict(nickname=nickname, ed25519=key.read_bytes()[32:].hex(),
                               hsdir=nickname in hsdir_flagged))
    if not any(r['hsdir'] for r in relays):
        sys.exit("no relay in the consensus carries the HSDir flag; the network is too young")

    valid_after = utc(times['valid-after'])
    voting = utc(times['fresh-until']) - valid_after
    offset_minutes = SHARED_RANDOM_N_ROUNDS * voting // 60
    period_length = SHARED_RANDOM_N_ROUNDS * SHARED_RANDOM_N_PHASES * voting // 60
    base_tp = (valid_after // 60 - offset_minutes) // period_length

    by_blinded = collections.defaultdict(list)
    for row in uploads.values():
        by_blinded[row['blindedKey']].append(row)

    cases, dropped = [], []
    for blinded, rows in sorted(by_blinded.items()):
        hit = None
        for srv_name, srv in sorted(srvs.items()):
            for tp in range(base_tp - 4, base_tp + 5):
                if all(relay_index(r['ed25519'], srv, tp, period_length) == r['relayIndex']
                       for r in rows):
                    hit = (srv_name, srv, tp)
                    break
            if hit:
                break
        if hit is None:
            dropped.append(blinded)
            continue
        srv_name, srv, tp = hit
        cases.append(dict(
            blindedKey=blinded,
            timePeriod=tp,
            periodLength=period_length,
            srvName=srv_name,
            sharedRandomValue=srv.hex(),
            which=sorted({r['which'] for r in rows})[0],
            serviceIndex=[service_index(blinded, rep, period_length, tp) for rep in REPLICAS],
            hsdirs=sorted(
                ({k: r[k] for k in ('nickname', 'ed25519', 'relayIndex', 'rsaFingerprint')}
                 for r in rows),
                key=lambda r: r['relayIndex']),
        ))

    if not cases:
        sys.exit("no group of uploads could be reproduced from a recorded SRV; capture again "
                 "sooner after the service publishes")

    json.dump(dict(
        source="tor 0.4.7.13 on a local chutney hs-v3 network",
        produced_by="packages/tor/tools/capture-hsdir.py",
        note=("Indices and blinded keys are tor's own, logged by upload_descriptor_to_hsdir(). The "
              "time period is the one that makes them reproduce; a group that reproduces under no "
              "recorded SRV is dropped, which is expected for uploads older than the consensus's "
              "two shared random values."),
        serviceIndexNote=("serviceIndex is computed here from the spec's formula rather than "
                          "observed — tor does not log it. It is checked indirectly: the HSDirs tor "
                          "chose must be the ones that follow these indices around the ring."),
        consensus=dict(validAfter=times['valid-after'], freshUntil=times['fresh-until'],
                       votingIntervalSeconds=voting),
        relays=relays,
        cases=cases,
        droppedBlindedKeys=dropped,
    ), sys.stdout, indent=2)
    print(file=sys.stdout)
    print(f"{len(cases)} case(s), {len(relays)} relays, {len(dropped)} dropped", file=sys.stderr)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1
         else str(pathlib.Path.home() / 'agent-b/workspaces/chutney/net/nodes'))
