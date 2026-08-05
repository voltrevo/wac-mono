/* Dump tor's own proposal-228 derivation for fixed curve25519 secrets.
 *
 * Built and run by `capture-prop228.py`, which explains why this exists. In short: the router
 * descriptors in `routerdesc_vectors.json` pin the curve25519 -> ed25519 *public* key conversion,
 * and cannot pin the secret-side derivation, because the string that derivation hashes affects only
 * the nonce prefix and a public key does not depend on it.
 *
 * Tor's own test suite does not pin it either — `test_crypto_ed25519_testvectors` overwrites the
 * derived secret with an ordinary ed25519 key before it signs anything, so no committed vector
 * anywhere covers a signature made with a proposal-228 nonce prefix. Calling tor's function directly
 * is the way to get one, and `ed25519_sign` here is what makes the prefix observable: ed25519 is
 * deterministic, so a signature is a fingerprint of the whole expanded secret.
 *
 * The secrets are fixed rather than generated so the vector is reproducible and reviewable, and they
 * are the same three the wac test builds, so the comparison is direct.
 */
#include <stdio.h>
#include <string.h>
#include "orconfig.h"
#include "lib/crypt_ops/crypto_ed25519.h"
#include "lib/crypt_ops/crypto_curve25519.h"
#include "lib/crypt_ops/crypto_init.h"
#include "lib/log/log.h"

static void hex(const char *name, const unsigned char *b, int n) {
  printf("%s ", name);
  for (int i = 0; i < n; i++) printf("%02x", b[i]);
  printf("\n");
}

int main(void) {
  init_logging(1);
  if (crypto_early_init() < 0) { fprintf(stderr, "crypto_early_init failed\n"); return 1; }

  for (int k = 0; k < 3; k++) {
    curve25519_keypair_t ckp;
    ed25519_keypair_t ekp;
    ed25519_signature_t sig;
    int bit = 0;
    memset(&ckp, 0, sizeof(ckp));

    for (int i = 0; i < 32; i++) ckp.seckey.secret_key[i] = (unsigned char)((k * 31 + 1) + i * 7);
    ckp.seckey.secret_key[0] &= 248;
    ckp.seckey.secret_key[31] &= 127;
    ckp.seckey.secret_key[31] |= 64;
    curve25519_public_key_generate(&ckp.pubkey, &ckp.seckey);

    if (ed25519_keypair_from_curve25519_keypair(&ekp, &bit, &ckp) < 0) return 1;

    const unsigned char msg[] = "prop228 nonce prefix, pinned";
    if (ed25519_sign(&sig, msg, sizeof(msg) - 1, &ekp) < 0) return 1;

    printf("case %d\n", k);
    hex("  curve_secret", ckp.seckey.secret_key, 32);
    hex("  curve_public", (unsigned char *)ckp.pubkey.public_key, 32);
    hex("  expanded", ekp.seckey.seckey, 64);
    hex("  ed_public", ekp.pubkey.pubkey, 32);
    printf("  signbit %d\n", bit);
    hex("  signature", sig.sig, 64);
  }
  return 0;
}
