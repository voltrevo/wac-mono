// A TCP listener that accepts and then says nothing at all — the peer 0018 is about.
const l = Deno.listen({ port: 5999, hostname: "127.0.0.1" });
console.error("silent relay listening on 5999");
for await (const c of l) { void c; /* hold it open, send nothing, ever */ }
