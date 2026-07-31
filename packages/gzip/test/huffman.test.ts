// Huffman structural tests, written in wac — see test/wac/huffman_test.wac.
//
// Previously this drove test/probe/huffman_probe.wac, a file whose only purpose
// was re-exporting internals one computed value at a time so TypeScript could
// compare them. The assertions now sit next to the code they describe, and the
// probe is gone.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

await wacTestRun("packages/gzip/test/wac/huffman_test.wac", "huffman");
