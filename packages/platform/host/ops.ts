// Opcodes, shared by both sides of the bridge.
//
// Numbers rather than names because they cross as an i32 in the control block, and a
// number nobody has to parse is one fewer thing to get wrong. Append only: a value that
// has shipped never changes meaning.

export const OP = {
  NOW_MILLIS: 1,
  MONOTONIC_NANOS: 2,
  RANDOM_BYTES: 3,
  LOG: 4,
  WARN: 5,
  ARG_COUNT: 6,
  ARG: 7,
  ENV: 8,
  READ_FILE: 9,
  WRITE_FILE: 10,
  READ_STDIN: 11,
  WRITE_STDOUT: 12,
  STAT: 13,
  READ_DIR: 14,
  MKDIR: 15,
  REMOVE: 16,
  RENAME: 17,
} as const;
