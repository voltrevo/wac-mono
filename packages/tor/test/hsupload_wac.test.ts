// Registers the wac-side upload-outcome tests.
//
// No captured vector: the three outcomes come from tor's `handle_response_upload_hsdesc`, which is
// read in the source rather than observed on a wire, and the *statuses* come from our own
// `hsPublishResponse` — which was pinned against tor's HSDir cache. So the numbers are checked at the
// end that produces them and the meanings at the end that reads them, and this joins the two.

import { wacTestRun } from "../../../harness/wacTestRun.ts";

await wacTestRun("packages/tor/test/wac/hsupload_test.wac", "hsupload", [
  () => new Uint8Array(),
]);
