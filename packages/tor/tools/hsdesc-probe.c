/* Put an onion service descriptor through tor's own decoder.
 *
 * The oracle for `src/hsdescgen.wac`. Two entry points, because a descriptor is built in layers and
 * an oracle that only worked on the finished article would mean building three of them blind:
 *
 *   plaintext   `hs_desc_decode_plaintext` — the version, the lifetime, the signing-key certificate
 *               and the signature over the document. The `superencrypted` object is opaque to it, so
 *               the outer shell can be checked before either encrypted layer exists.
 *   full        `hs_desc_decode_descriptor` with a subcredential — everything, both layers decrypted.
 *
 * Reads the descriptor on stdin. `full` takes the subcredential as hex in argv[2].
 *
 * Build it the way capture-prop228.py builds its probe — against a configured and built tor tree's
 * libtor.a.
 *
 * The signature span is the reason this exists rather than a round trip through our own reader. tor
 * finds `"\nsignature "`, steps *past the newline*, and signs everything before that — so the span
 * ends with the newline that closes the `superencrypted` object. Off by that one byte and the
 * document parses and the signature does not verify, which is the failure `hsservice.wac` already
 * records for a different cell.
 */
#include <stdio.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include "orconfig.h"
#include "core/or/or.h"
#include "feature/hs/hs_descriptor.h"
#include "feature/hs/hs_common.h"
#include "lib/crypt_ops/crypto_init.h"
#include "lib/crypt_ops/crypto_format.h"
#include "lib/log/log.h"
#include "app/config/config.h"
#include "app/main/subsysmgr.h"
#include <sys/stat.h>

static int
unhex(const char *s, uint8_t *out, size_t want)
{
  size_t n = strlen(s);
  while (n > 0 && (s[n - 1] == '\n' || s[n - 1] == '\r')) n--;
  if (n != want * 2) return -1;
  for (size_t i = 0; i < want; i++) {
    unsigned v;
    if (sscanf(s + i * 2, "%2x", &v) != 1) return -1;
    out[i] = (uint8_t)v;
  }
  return 0;
}

int
main(int argc, char **argv)
{
  subsystems_init();
  init_logging(1);
  {
    log_severity_list_t sev;
    set_log_severity_config(LOG_WARN, LOG_ERR, &sev);
    add_stream_log(&sev, "stderr", STDERR_FILENO);
  }
  if (crypto_global_init(0, NULL, NULL) < 0) {
    fprintf(stderr, "crypto_global_init failed\n");
    return 2;
  }
  /* The descriptor decoder reaches for the global options — `get_options_mutable` asserts on them —
   * so the same minimal `set_options` `parsedesc-probe.c` explains is needed here too. Without it
   * this aborts with a raw backtrace rather than a verdict. */
  {
    or_options_t *options = options_new();
    options_init(options);
    options->command = CMD_RUN_UNITTESTS;
    /* And a directory, because `check_private_dir` asserts on the name before anything reads it. */
    const char *dir = "/tmp/hsdesc-probe";
    mkdir(dir, 0700);
    options->DataDirectory = tor_strdup(dir);
    options->DataDirectory_option = tor_strdup(dir);
    tor_asprintf(&options->KeyDirectory, "%s/keys", dir);
    options->CacheDirectory = tor_strdup(dir);
    char *errmsg = NULL;
    if (set_options(options, &errmsg) < 0) {
      fprintf(stderr, "set_options failed: %s\n", errmsg ? errmsg : "(none)");
      return 2;
    }
  }

  size_t cap = 1 << 20, len = 0;
  char *buf = tor_malloc(cap);
  size_t n;
  while ((n = fread(buf + len, 1, cap - len - 1, stdin)) > 0) {
    len += n;
    if (len + 1 >= cap) { cap *= 2; buf = tor_realloc(buf, cap); }
  }
  buf[len] = '\0';

  const char *mode = argc > 1 ? argv[1] : "plaintext";

  if (!strcmp(mode, "plaintext")) {
    hs_desc_plaintext_data_t plaintext;
    memset(&plaintext, 0, sizeof(plaintext));
    if (hs_desc_decode_plaintext(buf, &plaintext) != HS_DESC_DECODE_OK) {
      printf("REJECTED\nreason: hs_desc_decode_plaintext\n");
      return 1;
    }
    printf("version: %u\n", plaintext.version);
    printf("lifetime_minutes: %u\n", plaintext.lifetime_sec / 60);
    printf("revision_counter: %" PRIu64 "\n", plaintext.revision_counter);
    printf("superencrypted_len: %d\n", (int)plaintext.superencrypted_blob_size);
    {
      char b64[ED25519_BASE64_LEN + 1];
      ed25519_public_to_base64(b64, &plaintext.signing_pubkey);
      printf("signing_pubkey: %s\n", b64);
      ed25519_public_to_base64(b64, &plaintext.blinded_pubkey);
      printf("blinded_pubkey: %s\n", b64);
    }
    printf("ACCEPTED\n");
    return 0;
  }

  if (!strcmp(mode, "full")) {
    if (argc < 3) { fprintf(stderr, "full needs the subcredential as hex\n"); return 2; }
    hs_subcredential_t subcred;
    if (unhex(argv[2], subcred.subcred, DIGEST256_LEN)) {
      fprintf(stderr, "the subcredential is not 32 bytes of hex\n");
      return 2;
    }
    hs_descriptor_t *desc = NULL;
    if (hs_desc_decode_descriptor(buf, &subcred, NULL, &desc) != HS_DESC_DECODE_OK) {
      printf("REJECTED\nreason: hs_desc_decode_descriptor\n");
      return 1;
    }
    printf("intro_points: %d\n",
           desc->encrypted_data.intro_points
             ? smartlist_len(desc->encrypted_data.intro_points) : 0);
    printf("ACCEPTED\n");
    return 0;
  }

  fprintf(stderr, "usage: hsdesc-probe plaintext|full [subcredential-hex] < descriptor\n");
  return 2;
}
