# size fixtures

Entry points that exist to be *compiled*, not called. Each re-exports one layer of the
client so `deno task size` can compile it alone and report what that layer costs.

They are here rather than in `src/` because nothing imports them and nothing should; they
are inputs to a measurement. `../src/client_entry.wac` is the real one — the whole client as
a single module, which is both the thing you would ship and the thing being measured.

Keeping them means the size number can be re-measured after a change instead of being a
figure someone wrote down once.
