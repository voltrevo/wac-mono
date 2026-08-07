"""Pin an ESTABLISH_INTRO cell against tor's own parser and its two verifications.

Unlike a microdescriptor, this cell's verdict *is* meaningful: it carries a MAC and a signature, and
tor checks both, so ACCEPTED means the bytes are right rather than merely well-shaped. Measured by
mutating each field — every one of them is refused, and the table lands in the vector so a test built
on the verdict can say what the verdict is worth.

The interesting case is the last one. The signature covers `start_cell .. end_sig_fields`, and
`end_sig_fields` sits *after* the MAC and *before* `sig_len` — so signing "everything before the
signature", which is the obvious reading, includes two bytes tor does not sign. That cell parses, its
MAC verifies, and its signature is refused.

Needs a *built* tor source tree (`libtor.a` at its root) and a cell from `src/genintro.wac`.

    deno task app:build packages/tor/src/genintro.wac --allow-write -o /tmp/genintro.ts
    deno run --allow-write /tmp/genintro.ts /tmp/cell.bin /tmp/base.json
    python3 packages/tor/tools/capture-estintro.py /tmp/cell.bin /tmp/base.json > \
        packages/tor/test/data/estintro_vectors.json
"""
import json
import pathlib
import subprocess
import sys
import tempfile

DEFAULT_TOR = pathlib.Path.home() / "tor-build" / "torproject-tor-c8d2b17"
PROBE = pathlib.Path(__file__).with_name("estintro-probe.c")


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


def ask(probe, tmp, blob, kh):
    """tor's verdict on one cell, and the spans it reports."""
    path = pathlib.Path(tmp) / "cell.bin"
    path.write_bytes(bytes(blob))
    r = subprocess.run([str(probe), str(path), kh], capture_output=True, text=True)
    out = {"accepted": r.returncode == 0, "reason": ""}
    for line in r.stdout.splitlines():
        if line.startswith("reason: "):
            out["reason"] = line[len("reason: "):]
        elif ": " in line:
            k, val = line.split(": ", 1)
            out[k] = int(val) if val.isdigit() else val
    return out


def main(argv):
    if len(argv) < 2:
        sys.exit(__doc__)
    cell = bytearray(pathlib.Path(argv[0]).read_bytes())
    base = json.loads(pathlib.Path(argv[1]).read_text())
    root = pathlib.Path(argv[2]) if len(argv) > 2 else DEFAULT_TOR
    kh = base["circuitKH"]

    with tempfile.TemporaryDirectory() as tmp:
        probe = pathlib.Path(tmp) / "eiprobe"
        build(root, probe)

        good = ask(probe, tmp, cell, kh)
        if not good["accepted"]:
            sys.exit(f"tor rejected the cell we are pinning: {good['reason']}")

        # One mutation per field, so the verdict is shown to discriminate rather than assumed to.
        mutations = []

        def mutate(name, blob, khhex=kh):
            v = ask(probe, tmp, blob, khhex)
            # The bytes are recorded as well as the verdict. A name and a verdict are enough to show
            # tor's parser discriminates; they are not enough for *our* parser to be asked the same
            # question, because it cannot reconstruct the cell from a description. Two ends agreeing
            # about a mutation neither is running is the failure this avoids.
            mutations.append({"name": name, "accepted": v["accepted"], "reason": v["reason"],
                              "cell": bytes(blob).hex(), "kh": khhex})

        b = bytearray(cell); b[5] ^= 1
        mutate("one bit of the auth key", b)
        b = bytearray(cell); b[good["mac_span_len"] + 4] ^= 1
        mutate("one bit of the handshake MAC", b)
        b = bytearray(cell); b[good["sig_span_len"] + 10] ^= 1
        mutate("one bit of the signature", b)
        mutate("the wrong circuit KH", cell, "00" * 20)
        b = bytearray(cell); b[0] = 1
        mutate("auth_key_type 1 instead of 2", b)
        mutate("truncated", cell[:60])

        # And the span trap, whose cell is produced by the caller because signing it needs the key.
        trap = pathlib.Path(argv[0]).with_name("ei-wrongspan.bin")
        if trap.exists():
            v = ask(probe, tmp, trap.read_bytes(), kh)
            mutations.append({
                "name": "signed over the obvious span, including sig_len",
                "accepted": v["accepted"],
                "reason": v["reason"],
                "cell": trap.read_bytes().hex(),
                "kh": kh,
            })

    out = dict(base)
    out["torSpans"] = {"macSpanLen": good["mac_span_len"], "sigSpanLen": good["sig_span_len"]}
    out["torParsedBytes"] = good["parsed_bytes"]
    out["mutations"] = mutations
    json.dump(out, sys.stdout, indent=1)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main(sys.argv[1:])
