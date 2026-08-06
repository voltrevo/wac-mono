/* Store a descriptor in tor's HSDir cache the way a real directory does, then look it back up.
 *
 * The oracle for publication. `hsdesc-probe.c` proves a *client* can decrypt what we generate;
 * this proves a *directory* will accept it, cache it, and hand it back — which is a different
 * check, because an HSDir never decrypts anything. It reads only the plaintext layer, and it
 * refuses a descriptor whose certificate does not verify, whose version it does not know, whose
 * lifetime is out of range, or whose blinded key does not match the one in the certificate. None
 * of that is exercised by decrypting.
 *
 * It also answers the question the upload path actually turns on: **under which name** does an
 * HSDir file a descriptor? Not one the uploader chooses — tor takes the blinded key out of the
 * descriptor's own certificate and keys the cache by that (`cache_store_v3_as_dir`), so a service
 * that computes the fetch URL from anything else publishes somewhere no client will look. So the
 * lookup here is by the base64 blinded key our `hsdirFetchPath` puts in the URL, and a match means
 * the two agree about the name.
 *
 *   hspub-probe <descriptor-file> <blinded-key-base64>
 *
 * Prints `stored: yes|no`, `lookup: hit|miss`, and `identical: yes|no` — whether the bytes an
 * HSDir would serve are the bytes we uploaded, since tor stores the encoded descriptor verbatim.
 *
 * Build it the way capture-blind.py builds its probe — against a configured and built tor tree's
 * libtor.a.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "orconfig.h"
#include "core/or/or.h"
#include "lib/crypt_ops/crypto_init.h"
#include "lib/log/log.h"
#include "feature/hs/hs_cache.h"
#include "feature/hs/hs_common.h"
#include "app/config/config.h"
#include "app/main/subsysmgr.h"
#include <unistd.h>
#include <sys/stat.h>

static char *
slurp(const char *path, size_t *len_out)
{
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  size_t cap = 1 << 16, len = 0;
  char *buf = tor_malloc(cap);
  for (;;) {
    if (len + 4096 + 1 > cap) { cap *= 2; buf = tor_realloc(buf, cap); }
    size_t n = fread(buf + len, 1, 4096, f);
    len += n;
    if (n < 4096) break;
  }
  fclose(f);
  buf[len] = '\0';
  if (len_out) *len_out = len;
  return buf;
}

int
main(int argc, char **argv)
{
  if (argc < 3) {
    fprintf(stderr, "usage: hspub-probe <descriptor-file> <blinded-key-base64>\n");
    return 2;
  }
  /* Unbuffered, because tor aborts the process on a failed assertion and buffered output is lost
   * with it — which is indistinguishable from a probe that printed nothing at all. */
  setvbuf(stdout, NULL, _IONBF, 0);
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
  /* The cache reaches for the global options, the same way the descriptor decoder does — see the
   * note in `parsedesc-probe.c`. Without them the first `get_options` asserts. */
  {
    or_options_t *options = options_new();
    options_init(options);
    options->command = CMD_RUN_UNITTESTS;
    char dir[] = "/tmp/hspub-probe-XXXXXX";
    if (!mkdtemp(dir)) { fprintf(stderr, "mkdtemp failed\n"); return 2; }
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
  hs_init();

  size_t desc_len = 0;
  char *desc = slurp(argv[1], &desc_len);
  if (!desc) {
    fprintf(stderr, "cannot read %s\n", argv[1]);
    return 2;
  }

  int stored = hs_cache_store_as_dir(desc);
  printf("stored: %s\n", stored == 0 ? "yes" : "no");
  if (stored != 0) {
    printf("FAILED\nreason: an HSDir would not accept this descriptor\n");
    return 1;
  }

  const char *got = NULL;
  int found = hs_cache_lookup_as_dir(3, argv[2], &got);
  printf("lookup: %s\n", found == 1 ? "hit" : (found == 0 ? "miss" : "bad-query"));
  if (found != 1) {
    printf("FAILED\nreason: nothing is filed under that blinded key\n");
    return 1;
  }

  /* An HSDir serves back exactly what it was given; anything else and a client's signature check
   * over the document would fail. */
  int same = (strlen(got) == desc_len) && memcmp(got, desc, desc_len) == 0;
  printf("identical: %s\n", same ? "yes" : "no");
  printf("served_len: %zu\n", strlen(got));
  printf("uploaded_len: %zu\n", desc_len);
  if (!same) {
    printf("FAILED\nreason: the bytes an HSDir would serve are not the ones uploaded\n");
    return 1;
  }

  printf("OK\n");
  return 0;
}
