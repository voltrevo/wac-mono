// CRC-32 tests written in wac — the table-driven version against the bitwise
// definition. See test/wac/crc32_test.wac.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

await wacTestRun("packages/gzip/test/wac/crc32_test.wac", "crc32");
