// Shared test helpers: decompress with external tools, so correctness is judged
// by something other than this codebase.

/** Decompress with the system gunzip; throws if it rejects the stream. */
export async function gunzip(gz: Uint8Array): Promise<Uint8Array> {
  const cmd = new Deno.Command("gunzip", {
    args: ["-c"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const w = child.stdin.getWriter();
  await w.write(gz);
  await w.close();
  const { code, stdout, stderr } = await child.output();
  if (code !== 0) {
    throw new Error(`gunzip rejected the stream (exit ${code}): ${new TextDecoder().decode(stderr)}`);
  }
  return stdout;
}

/** Compress with python gzip, for testing a decompressor against a real encoder. */
export async function pythonGzip(data: Uint8Array, level = 6): Promise<Uint8Array> {
  const cmd = new Deno.Command("python3", {
    args: ["-c", `import sys,gzip; sys.stdout.buffer.write(gzip.compress(sys.stdin.buffer.read(), ${level}))`],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const w = child.stdin.getWriter();
  await w.write(data);
  await w.close();
  const { code, stdout, stderr } = await child.output();
  if (code !== 0) {
    throw new Error(`python gzip failed (exit ${code}): ${new TextDecoder().decode(stderr)}`);
  }
  return stdout;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return -2;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

/** Compress with `fn`, decompress with the system gunzip, require an exact match. */
export async function roundTrip(
  fn: (data: Uint8Array) => Uint8Array,
  name: string,
  input: Uint8Array,
): Promise<void> {
  const gz = fn(input);
  const out = await gunzip(gz);
  const diff = bytesEqual(out, input);
  if (diff === -2) {
    throw new Error(`${name}: gunzip gave ${out.length} bytes, expected ${input.length}`);
  }
  if (diff >= 0) {
    throw new Error(`${name}: byte ${diff} differs — got ${out[diff]}, expected ${input[diff]}`);
  }
}
