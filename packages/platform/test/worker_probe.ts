// A worker that makes one host call and reports what came back.
//
// The tests need it because `hostCall` blocks, and blocking is only legal off the main
// thread — running it inline would deadlock against the very responder meant to answer.

import { bridgeOf } from "../host/layout.ts";
import { hostCall, unstr } from "../host/call.ts";

const worker = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(m: unknown): void;
};

worker.onmessage = (e: MessageEvent) => {
  const { sab, op, payload, asText } = e.data as {
    sab: SharedArrayBuffer;
    op: number;
    payload: Uint8Array;
    asText?: boolean;
  };
  try {
    const out = hostCall(bridgeOf(sab), op, payload);
    worker.postMessage(
      asText
        ? { text: unstr(out) }
        : { len: out.length, first: out[0], last: out[out.length - 1] },
    );
  } catch (err) {
    worker.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};
