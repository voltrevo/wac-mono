// A corpus of real data, for measuring a compressor against something that resembles its use.
//
// The samples this package started with were repeated phrases, and they were actively
// misleading: 0.1 literal bytes per sequence, every offset the same, and a ratio that said more
// about the generator than the compressor. Real data has irregular matches, a literal stream
// worth coding, and offsets that wander.
//
// Everything here comes from files that are already on the machine — mostly this repository,
// which is the most reproducible source available and is itself a fair sample of what people
// compress. Samples that need something outside the repo are skipped rather than faked, and
// `describe` reports what was actually used so a number is never quoted without its source.

/** One sample: what it is, where it came from, and the bytes. */
export type Sample = { name: string; source: string; data: Uint8Array };

const enc = new TextEncoder();

async function readIfPresent(path: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(path);
  } catch {
    return null;
  }
}

/** Concatenate files matching `pred` under `root`, up to `limit` bytes. */
async function gather(root: string, pred: (p: string) => boolean, limit: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    if (total >= limit) return;
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return;
    }
    entries.sort((a, b) => a.name < b.name ? -1 : 1);      // deterministic order
    for (const entry of entries) {
      if (total >= limit) return;
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        if (entry.name === ".git" || entry.name === ".cache" || entry.name === "node_modules") continue;
        await walk(path);
      } else if (pred(path)) {
        const bytes = await readIfPresent(path);
        if (bytes === null) continue;
        parts.push(bytes);
        total += bytes.length;
      }
    }
  };
  await walk(root);
  const out = new Uint8Array(Math.min(total, limit));
  let at = 0;
  for (const p of parts) {
    const n = Math.min(p.length, out.length - at);
    out.set(p.subarray(0, n), at);
    at += n;
    if (at >= out.length) break;
  }
  return out;
}

/** The wasm one of our own modules compiles to: a real binary, and always available. */
async function wasmSample(): Promise<Uint8Array | null> {
  const { wacCompile } = await import("wac/wacCompile.ts");
  const { wacBindgen } = await import("wac/wacBindgen.ts");
  const { wacFiles } = await import("../../../harness/wacFiles.ts");
  try {
    const entry = "packages/zstd/src/frame.wac";
    const result = wacCompile(await wacFiles(entry), entry);
    if (!result.ok) return null;
    const ts = wacBindgen(result.compiled);
    const b64 = ts.match(/atob\("([^"]*)"\)/)?.[1];
    if (b64 === undefined) return null;
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * The corpus, in the order a reader should think about it.
 *
 * Sizes are capped so the whole set stays a few megabytes: a benchmark nobody runs because it
 * takes a minute is a benchmark that stops being run.
 */
export async function corpus(): Promise<Sample[]> {
  const out: Sample[] = [];
  const add = (name: string, source: string, data: Uint8Array | null) => {
    if (data !== null && data.length > 0) out.push({ name, source, data });
  };

  // Source code, three languages with different shapes: wac is dense and regular, TypeScript is
  // verbose, Python is neither and comes from outside this project.
  add("wac source", "packages/*/src/**.wac", await gather("packages", p => p.endsWith(".wac"), 1 << 20));
  add("typescript", "harness, tools, packages/*/host", await gather(".", p => p.endsWith(".ts") && !p.includes("/.cache/"), 1 << 20));
  add("python", "/usr/lib/python3.12", await gather("/usr/lib/python3.12", p => p.endsWith(".py"), 1 << 20));

  // English prose with light markup, which is what most "text" benchmarks actually measure.
  add("markdown", "**/*.md", await gather(".", p => p.endsWith(".md"), 512 << 10));

  // Structured data: many small files, so the same keys recur at every scale.
  add("json", "**/*.json and deno.lock", await gather(".", p => p.endsWith(".json") || p.endsWith(".lock"), 512 << 10));

  // A real binary. Machine code compresses differently from text: fewer long matches, and a
  // literal stream that is far from uniform.
  add("wasm", "packages/zstd/src/frame.wac, compiled", await wasmSample());
  for (const path of ["/usr/local/bin/deno", "/usr/bin/node", "/usr/bin/python3.12"]) {
    const elf = await readIfPresent(path);
    if (elf !== null) {
      // From a megabyte in: the first pages of a large executable are headers and tables, which
      // compress unlike the code that follows them.
      add("native binary", path + ", 1 MB from offset 1 MB", elf.subarray(1 << 20, 2 << 20));
      break;
    }
  }

  // Already compressed, which must not expand and cannot compress.
  const wac = out.find(s => s.name === "wac source");
  if (wac !== undefined) {
    add("gzipped source", "the wac sample, gzipped", await gzip(wac.data));
  }

  return out;
}

/** gzip through the host, so the sample is genuinely incompressible rather than pseudo-random. */
async function gzip(data: Uint8Array): Promise<Uint8Array | null> {
  try {
    const stream = new Blob([data.slice()]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** One line per sample, for printing above a table of results. */
export function describe(samples: Sample[]): string {
  return samples.map(s => `  ${s.name.padEnd(16)} ${String(s.data.length).padStart(9)} bytes  ${s.source}`).join("\n");
}
