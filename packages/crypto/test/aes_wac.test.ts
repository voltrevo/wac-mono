// Registers the wac-side AES tests and supplies the host cipher.
//
// ECB is in here deliberately. It is not a mode anyone should use, and it is the only way
// to ask a library for one bare block transform — which is the thing the modes are built
// on and the thing worth checking independently.
import { createCipheriv } from "node:crypto";
import { Buffer } from "node:buffer";
import { wacTestRun } from "../../../harness/wacTestRun.ts";

const ECB = 0, CTR = 1, GCM = 2;
const bits = (key: Uint8Array) => key.length * 8;

function ref(
  mode: number, key: Uint8Array, iv: Uint8Array, aad: Uint8Array, data: Uint8Array,
): Uint8Array {
  if (mode === ECB) {
    const c = createCipheriv(`aes-${bits(key)}-ecb`, key, null);
    c.setAutoPadding(false);
    return new Uint8Array(Buffer.concat([c.update(data), c.final()]));
  }
  if (mode === CTR) {
    const c = createCipheriv(`aes-${bits(key)}-ctr`, key, iv);
    return new Uint8Array(Buffer.concat([c.update(data), c.final()]));
  }
  const c = createCipheriv(`aes-${bits(key)}-gcm`, key, iv, { authTagLength: 16 });
  c.setAAD(aad, { plaintextLength: data.length });
  const body = Buffer.concat([c.update(data), c.final()]);
  return new Uint8Array(Buffer.concat([body, c.getAuthTag()]));
}

await wacTestRun("packages/crypto/test/wac/aes_test.wac", "aes", [ref]);
