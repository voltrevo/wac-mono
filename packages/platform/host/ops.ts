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
  OPEN_INPUT: 18,
  READ_CHUNK: 19,
  OPEN_OUTPUT: 20,
  CONNECT: 21,
  LISTEN: 22,
  ACCEPT: 23,
  RECV: 24,
  SEND: 25,
  CLOSE_SOCKET: 26,
  SPAWN: 27,
  EXIT_CODE: 28,
  CLOSE_FEED: 29,
} as const;
