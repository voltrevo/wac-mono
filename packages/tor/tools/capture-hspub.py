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


def ask(probe, tmp, desc, query):
    """Run the probe over one descriptor and one query, and report what tor did with each."""
    p = pathlib.Path(tmp) / "desc.txt"
    p.write_text(desc)
    r = subprocess.run([str(probe), str(p), query], capture_output=True, text=True)
    got = dict(line.split(": ", 1) for line in r.stdout.splitlines() if ": " in line)
    return dict(
        stored=got.get("stored") == "yes",
        lookup=got.get("lookup", "none"),
        identical=got.get("identical") == "yes",
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

        # Each control is a descriptor tor must refuse, or a name it must not find. Without them a
        # probe that returned "stored" unconditionally would look identical to this one.
        mid = desc.index("superencrypted") + 60
        sig = desc.rindex("\nsignature ") + 12
        controls = [
            dict(name="one byte of the encrypted body flipped",
                 result=ask(probe, tmp,
                            desc[:mid] + ("X" if desc[mid] != "X" else "Y") + desc[mid + 1:],
                            query)),
            dict(name="the document signature corrupted",
                 result=ask(probe, tmp, desc[:sig] + "A" + desc[sig + 1:], query)),
            dict(name="truncated after the first line",
                 result=ask(probe, tmp, desc.split("\n")[0] + "\n", query)),
            dict(name="the right descriptor, looked up under an all-zero key",
                 result=ask(probe, tmp, desc,
                            base64.b64encode(bytes(32)).decode().rstrip("="))),
        ]
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
        controls=controls,
    ), sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main(sys.argv[1:])
