#!/usr/bin/env python3
"""Differential-testing oracle: python's zlib/gzip, driven in one batch.

Spawning a python process per case would dominate the runtime, so the whole
corpus is handed over at once. Reads a work directory containing:

    in/<i>.bin     the original input
    ours/<i>.gz    our compressor's output for that input

and for every case:

  1. decompresses ours/<i>.gz with python's gzip and compares to in/<i>.bin
  2. compresses in/<i>.bin with python at level i % 10, writing theirs/<i>.gz
     for our decompressor to read back

Failures are reported on stdout as "FAIL <i> <reason>"; the last line is
"DONE <count>". Any output other than that shape is a harness problem, not a
compression bug, and the caller treats it as such.
"""

import gzip
import os
import sys
import zlib


def main() -> int:
    work = sys.argv[1]
    count = int(sys.argv[2])
    os.makedirs(f"{work}/theirs", exist_ok=True)

    for i in range(count):
        with open(f"{work}/in/{i}.bin", "rb") as f:
            original = f.read()

        # 1. Can python read what we wrote?
        with open(f"{work}/ours/{i}.gz", "rb") as f:
            ours = f.read()
        try:
            got = gzip.decompress(ours)
        except Exception as e:                      # noqa: BLE001 - report, don't crash
            print(f"FAIL {i} python-rejected-our-stream: {type(e).__name__}: {e}")
            continue
        if got != original:
            if len(got) != len(original):
                print(f"FAIL {i} our-stream-wrong-length: got {len(got)}, want {len(original)}")
            else:
                at = next(k for k in range(len(got)) if got[k] != original[k])
                print(f"FAIL {i} our-stream-wrong-bytes: first differs at {at}")
            continue

        # Also check the raw deflate payload against zlib directly, which is
        # stricter than gzip.decompress about trailing garbage.
        try:
            zlib.decompress(ours, 16 + zlib.MAX_WBITS)
        except Exception as e:                      # noqa: BLE001
            print(f"FAIL {i} zlib-strict-rejected: {type(e).__name__}: {e}")
            continue

        # 2. Produce a stream for us to read back, varying the level so stored,
        #    fixed and dynamic blocks all appear across the corpus.
        level = i % 10
        with open(f"{work}/theirs/{i}.gz", "wb") as f:
            f.write(gzip.compress(original, level))

    print(f"DONE {count}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
