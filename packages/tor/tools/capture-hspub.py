"""Pin publication against a real HSDir: tor's own descriptor cache.

`hsdesc-probe.c` proves a *client* can decrypt what `genhsdesc` generates. This proves a *directory*
will take it — a different question, because an HSDir never decrypts anything. It reads the plaintext
layer only, checks the signing-key certificate, and files the descriptor under the blinded key it
finds *inside* that certificate.

That last part is what publication turns on, and why this exists rather than a test of our own URL
builder. The uploader does not name the descriptor: it POSTs to `/tor/hs/3/publish`, with no key in
the path at all, and the HSDir decides the name. So a service whose blinded key and descriptor
disagreed would upload successfully, be told "stored", and be unreachable — every check short of
asking the directory what name it used would pass. The lookup here uses the base64 blinded key our
`descriptorPath` puts in the fetch URL, so a hit means the two names agree.

The controls are recorded alongside, because a probe that accepts everything would produce exactly
the same `stored: yes` for the real descriptor. Each is a descriptor tor must refuse, or a name it
must not find.

Needs a *built* tor source tree (`libtor.a` at its root).

    python3 packages/tor/tools/capture-hspub.py > packages/tor/test/data/hspublish.json
"""
import base64
import binascii
import json
import pathlib
import subprocess
import sys
import tempfile

DEFAULT_TOR = pathlib.Path.home() / "tor-build" / "torproject-tor-c8d2b17"
PROBE = pathlib.Path(__file__).with_name("hspub-probe.c")
GENERATED = pathlib.Path(__file__).parents[1] / "test" / "data" / "hsdesc_generated.json"


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


def ask(probe, tmp, descs, query):
    """Upload `descs` in order to one fresh HSDir cache, and report what tor did with each."""
    if isinstance(descs, str):
        descs = [descs]
    paths = []
    for i, d in enumerate(descs):
        p = pathlib.Path(tmp) / f"desc{i}.txt"
        p.write_text(d)
        paths.append(str(p))
    r = subprocess.run([str(probe), query] + paths, capture_output=True, text=True)
    got = dict(line.split(": ", 1) for line in r.stdout.splitlines() if ": " in line)
    stored = [got.get(f"stored[{i}]") == "yes" for i in range(len(descs))]
    return dict(
        stored=stored[0],
        storedEach=stored,
        served=int(got.get("served", -1)),
        lookup=got.get("lookup", "none"),
        identical=got.get("served", "-1") == "0",
        accepted=r.returncode == 0,
    )


def main(argv):
    root = pathlib.Path(argv[0]) if argv else DEFAULT_TOR
    gen = json.loads(GENERATED.read_text())
    desc = gen["descriptor"]
    blinded = binascii.unhexlify(gen["blindPublic"])
    query = base64.b64encode(blinded).decode().rstrip("=")

    with tempfile.TemporaryDirectory() as tmp:
        probe = pathlib.Path(tmp) / "hspub"
        build(root, probe)

        real = ask(probe, tmp, desc, query)
        if not (real["stored"] and real["lookup"] == "hit" and real["identical"]):
            sys.exit(f"an HSDir would not publish our descriptor: {real}")

        # The sequence rules. An HSDir replaces what it holds only when the revision counter is
        # strictly greater, so which descriptor a client is served depends on the order uploads
        # arrived — and a service that republished an unchanged document would be refused. None of
        # this is visible from one upload, which is why `genhsdesc` emits a second document that
        # differs from the first only in that counter.
        newer = gen["descriptorNext"]
        sequences = [
            dict(name="the newer revision replaces the older",
                 order=["current", "next"], result=ask(probe, tmp, [desc, newer], query)),
            dict(name="an older revision does not overwrite a newer",
                 order=["next", "current"], result=ask(probe, tmp, [newer, desc], query)),
            dict(name="an unchanged descriptor is refused the second time",
                 order=["current", "current"], result=ask(probe, tmp, [desc, desc], query)),
        ]
        for s_ in sequences:
            if s_["result"]["storedEach"][0] is not True:
                sys.exit(f"the first upload of {s_['name']!r} was refused")
        if sequences[0]["result"]["storedEach"] != [True, True]:
            sys.exit("tor did not accept a strictly newer revision")
        if sequences[1]["result"]["storedEach"] != [True, False]:
            sys.exit("tor accepted an older revision over a newer one")
        if sequences[2]["result"]["storedEach"] != [True, False]:
            sys.exit("tor accepted an unchanged descriptor twice")

        # Each control is a descriptor tor must refuse, or a name it must not find. Without them a
        # probe that returned "stored" unconditionally would look identical to this one.
        # Each edit is recorded rather than described, so the wac side can reproduce the exact bytes
        # tor was given. A control the two ends build separately is a control they can disagree about
        # silently, which is the one thing this file exists to prevent.
        mid = desc.index("superencrypted") + 60
        sig = desc.rindex("\nsignature ") + 12
        cert = desc.index("-----BEGIN ED25519 CERT-----") + 40
        edits = [
            ("one byte of the encrypted body flipped",
             dict(kind="replace", offset=mid, byte="X" if desc[mid] != "X" else "Y")),
            ("the document signature corrupted",
             dict(kind="replace", offset=sig, byte="A" if desc[sig] != "A" else "B")),
            ("one byte of the signing certificate flipped",
             dict(kind="replace", offset=cert, byte="A" if desc[cert] != "A" else "B")),
            ("truncated after the first line",
             dict(kind="truncate", length=len(desc.split("\n")[0]) + 1)),
        ]
        controls = []
        for name, edit in edits:
            if edit["kind"] == "replace":
                at = edit["offset"]
                body = desc[:at] + edit["byte"] + desc[at + 1:]
                assert body != desc, name
            else:
                body = desc[:edit["length"]]
            controls.append(dict(name=name, edit=edit, result=ask(probe, tmp, body, query)))
        controls.append(dict(
            name="the right descriptor, looked up under an all-zero key",
            edit=dict(kind="none"),
            result=ask(probe, tmp, desc, base64.b64encode(bytes(32)).decode().rstrip("="))))
        for c in controls:
            if c["result"]["accepted"]:
                sys.exit(f"the control {c['name']!r} was accepted, so the probe proves nothing")

    json.dump(dict(
        source="tor's own hs_cache_store_as_dir and hs_cache_lookup_as_dir, tor 0.4.7.13",
        produced_by="packages/tor/tools/capture-hspub.py",
        note=("An HSDir keys a descriptor by the blinded key inside its signing-key certificate, not "
              "by anything the uploader says — the publish URL carries no key at all. So `query` is "
              "the name tor chose, and our fetch path has to produce the same one or a service "
              "publishes into a slot nobody looks in."),
        descriptorFrom="packages/tor/test/data/hsdesc_generated.json",
        blindedKey=gen["blindPublic"],
        query=query,
        descriptorLength=len(desc),
        stored=real["stored"],
        servedIdentical=real["identical"],
        revision=gen["revision"],
        revisionNext=gen["revisionNext"],
        sequences=sequences,
        controls=controls,
    ), sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main(sys.argv[1:])
