# Issues

Bug reports and cross-cutting tasks for the packages in this repo. The compiler has
its own tracker — a wac *compiler* bug belongs in `wac/issues/`, even when you found
it writing a package here.

## When to file rather than just fix it

Packages have de facto owners, so the rule is about who is likely to be mid-change:

- **A package you are working in:** just fix it. An issue you close in the same
  session is noise.
- **A package someone else is working in:** file it. A change that reaches into
  another agent's package while they have uncommitted work costs both of you more
  than the fix is worth.
- **Anything that makes `deno task test` red for everyone:** file it *and* say so in
  the summary, because the next person to pull cannot tell whose failure it is.
- **Work that is blocked on something else:** file it, with what it is waiting for.
  That is the difference between "nobody has done this" and "this cannot be done yet".

## What does not belong here

Three things already have homes, and duplicating them means two records that drift:

| where it goes | what |
|---|---|
| the package's `README.md` | that package's own known limitations and roadmap — its "Not here yet" section |
| `~/notes/living/wac/language-friction-log.md` | language gaps, ranked across projects. "No generics" is not an issue, it is a measured cost |
| `wac/issues/` | anything whose fix is in the compiler |

An issue is for something **actionable that is not already written down**.

## Filing one

Add `issues/open/NNNN-short-slug.md`, taking the next free number, from
`TEMPLATE.md`. Commit it on the primary branch; an issue is not a code change, so
there is nothing to coordinate.

Numbers can collide when two agents file at once. If that happens, renumber yours —
it is a rename, and the loser is whoever pushes second.

Add a row to `INDEX.md` in the same commit. The index is the thing people read.

## Closing one

Move the file to `issues/closed/` in the commit that fixes it, and set `Status:` to
what happened — `fixed`, `wontfix`, or `obsolete` with a reason. Keeping closed
issues rather than deleting them is what makes "was this ever a problem?" answerable
without archaeology.

## What makes a report worth having

A reproduction. For a package, the smallest input that misbehaves and what you
expected instead; for a build failure, the exact error. If you narrowed it, say what
you tried — "passes on the 3-byte input, fails at 4" is worth more than a paragraph.
