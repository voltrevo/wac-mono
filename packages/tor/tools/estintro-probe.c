/* Put an ESTABLISH_INTRO cell through tor's own parser and its own two verifications.
 *
 * The oracle for `src/hsservice.wac`. What makes this worth building rather than checking our
 * signature with our verifier is the pair of `@ptr` markers in
 * `src/trunnel/hs/cell_establish_intro.trunnel`: the MAC covers everything before the MAC, and the
 * signature covers everything before *`sig_len`* — which means it includes the MAC and excludes the
 * two length bytes that follow it. Nothing in the cell's shape says so. A builder that signs
 * "everything before the signature", which is the obvious reading, produces a cell that parses
 * perfectly and fails verification.
 *
 * So this reads the spans **out of tor's parsed cell** rather than recomputing them, and reports
 * where tor thinks each one ends. A test comparing our spans against those numbers cannot agree with
 * a comment that has drifted.
 *
 * Input on stdin: the cell body, then a newline, then two hex lines — the circuit KH the MAC should
 * be keyed with, and nothing else. Concretely, this reads a small JSON-free format because the cell
 * is binary:
 *
 *     argv[1] = path to the raw cell body
 *     argv[2] = the circuit KH as hex
 *
 * Exit 0 and a report, or exit 1 and REJECTED with the reason tor gives.
 *
 * Build it the way capture-prop228.py builds its probe — against a configured and built tor tree's
 * libtor.a.
 */
#include <stdio.h>
#include <unistd.h>
#include <stdlib.h>
#include <string.h>
#include "orconfig.h"
#include "core/or/or.h"
#include "trunnel/hs/cell_establish_intro.h"
#include "lib/crypt_ops/crypto_init.h"
#include "lib/crypt_ops/crypto_digest.h"
#include "lib/crypt_ops/crypto_ed25519.h"
#include "lib/crypt_ops/crypto_format.h"
#include "lib/log/log.h"
#include "app/config/config.h"
#include "app/main/subsysmgr.h"
#include "feature/hs/hs_common.h"

static int
unhex(const char *s, uint8_t *out, size_t max, size_t *len_out)
{
  size_t n = strlen(s);
  while (n > 0 && (s[n - 1] == '\n' || s[n - 1] == '\r')) n--;
  if (n % 2 || n / 2 > max) return -1;
  for (size_t i = 0; i < n / 2; i++) {
    unsigned v;
    if (sscanf(s + i * 2, "%2x", &v) != 1) return -1;
    out[i] = (uint8_t)v;
  }
  *len_out = n / 2;
  return 0;
}

int
main(int argc, char **argv)
{
  if (argc < 3) {
    fprintf(stderr, "usage: estintro-probe <cell-file> <circuit-kh-hex>\n");
    return 2;
  }

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

  uint8_t cell[2048];
  size_t cell_len = 0;
  {
    FILE *fp = fopen(argv[1], "rb");
    if (!fp) { fprintf(stderr, "cannot open %s\n", argv[1]); return 2; }
    cell_len = fread(cell, 1, sizeof(cell), fp);
    fclose(fp);
  }

  uint8_t kh[64];
  size_t kh_len = 0;
  if (unhex(argv[2], kh, sizeof(kh), &kh_len) < 0) {
    fprintf(stderr, "the circuit KH is not hex\n");
    return 2;
  }

  trn_cell_establish_intro_t *parsed = NULL;
  ssize_t n = trn_cell_establish_intro_parse(&parsed, cell, cell_len);
  if (n < 0 || !parsed) {
    printf("REJECTED\nreason: trn_cell_establish_intro_parse returned %d\n", (int)n);
    return 1;
  }
  printf("parsed_bytes: %d\n", (int)n);
  printf("cell_bytes: %d\n", (int)cell_len);
  printf("auth_key_type: %d\n", trn_cell_establish_intro_get_auth_key_type(parsed));
  printf("auth_key_len: %d\n", trn_cell_establish_intro_get_auth_key_len(parsed));
  printf("sig_len: %d\n", trn_cell_establish_intro_get_sig_len(parsed));

  /* The spans, as *tor* sees them. These are the numbers the wac side is compared against — the
   * point of the probe. */
  const uint8_t *start = trn_cell_establish_intro_get_start_cell(parsed);
  const uint8_t *end_mac = trn_cell_establish_intro_get_end_mac_fields(parsed);
  const uint8_t *end_sig = trn_cell_establish_intro_get_end_sig_fields(parsed);
  printf("mac_span_len: %d\n", (int)(end_mac - start));
  printf("sig_span_len: %d\n", (int)(end_sig - start));

  /* The MAC, tor's construction, keyed with the circuit material. */
  {
    uint8_t mac[DIGEST256_LEN];
    crypto_mac_sha3_256(mac, sizeof(mac), kh, kh_len, start, (size_t)(end_mac - start));
    const uint8_t *theirs = trn_cell_establish_intro_getconstarray_handshake_mac(parsed);
    if (tor_memneq(mac, theirs, sizeof(mac))) {
      printf("REJECTED\nreason: handshake_auth not as expected\n");
      return 1;
    }
    printf("mac: ok\n");
  }

  /* The signature, over the prefix and the span tor reports. */
  {
    ed25519_signature_t sig;
    ed25519_public_key_t auth_key;
    if (trn_cell_establish_intro_getlen_sig(parsed) != sizeof(sig.sig)) {
      printf("REJECTED\nreason: sig len is invalid\n");
      return 1;
    }
    memcpy(sig.sig, trn_cell_establish_intro_getconstarray_sig(parsed), sizeof(sig.sig));
    memcpy(auth_key.pubkey, trn_cell_establish_intro_getconstarray_auth_key(parsed),
           ED25519_PUBKEY_LEN);
    if (ed25519_checksig_prefixed(&sig, start, (size_t)(end_sig - start),
                                  ESTABLISH_INTRO_SIG_PREFIX, &auth_key)) {
      printf("REJECTED\nreason: signature not as expected\n");
      return 1;
    }
    printf("signature: ok\n");
  }

  printf("ACCEPTED\n");
  trn_cell_establish_intro_free(parsed);
  return 0;
}
