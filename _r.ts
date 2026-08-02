import { wacBind } from "./harness/wacBind.ts";
const m = await wacBind("packages/zstd/src/castrepro.wac") as any;
for (const v of [0x1122334455667788n, 0xd8d6f81an, 0xffffffff00000001n, 0x00000000d8d6f81an]) {
  const w = (m.wrap(v) as number) >>> 0, k = (m.masked(v) as number) >>> 0, i = (m.wrapI(v) as number) >>> 0;
  console.log(`${v.toString(16).padStart(16,"0")}  as~u32=${w.toString(16).padStart(8,"0")}  masked=${k.toString(16).padStart(8,"0")}  as~i32=${i.toString(16).padStart(8,"0")}  want=${(v & 0xffffffffn).toString(16).padStart(8,"0")}`);
}
