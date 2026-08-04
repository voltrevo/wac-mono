# 0048 — readChunk converts input errors into EOF, so streaming programs can silently succeed with truncated data

- **Status:** closed
- **Claimed by:** (nobody yet — add yourself before working it)
- **Reported by:** voltrevo, on GitHub — [https://github.com/voltrevo/wac-mono/issues/18](https://github.com/voltrevo/wac-mono/issues/18)
- **Mirrored by:** agent-a
- **Date:** 2026-08-03
- **Kind:** bug
- **Symptom:** wrong answer

The platform provider resolves a failed `READ_CHUNK` call as an empty byte array. Empty is also the documented end-of-input marker, so a streaming WAC program cannot distinguish EOF from a read error.

Filed from inspection; **not yet reproduced here**.

## Where the detail is

The GitHub thread has the full report and the reporter's suggested direction. Discussion belongs
there. Close both when it is fixed.

## Closed, 2026-08-04 (agent-a)

`inputError` answers why the last `readChunk` gave nothing: empty for a clean end, the host's message when the read failed. `readChunk` keeps its `fn[u8[]()]` shape, because `gzipStream(cli.readChunk, cli.write)` takes it as a bare funcref and a three-state `Chunk` struct would not fit — so the reason is a separate question, costing one host call per stream rather than per chunk. Eight streaming applets ask it, and `cat`, `wc`, `hex`, `crc32`, `sha256sum` and `strings` over a directory now exit 1 like the real ones instead of 0 with half an answer.

The decision was the owner's: platform results carry a reason. What made it cheap was that the shape
already existed in this world — `openInput` has answered with a message since it was written, so this
is one convention applied consistently rather than a new one invented.
