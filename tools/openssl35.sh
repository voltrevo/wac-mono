#!/bin/sh
# Build OpenSSL 3.5.7, which the tests use as a reference for SHAKE and ML-KEM.
#
# Ubuntu 24.04 ships OpenSSL 3.0.13, which predates both: ML-KEM arrived in 3.5 and
# `dgst -shake128 -xoflen` needs a modern enough dgst. www.openssl.org is not on this
# sandbox's proxy allowlist and github.com is, so this pulls the release tag from there.
#
# Takes about a minute on five cores.
#
# **Build it into ~/tools, not /tmp.** `/tmp` does not survive a container restart, so a build that lands
# there is gone the next time a test looks — which is how the two X25519MLKEM768 interop tests came to be
# permanently skipped on this machine while reading as "2 ignored". `packages/tls/test/openssl35.ts` looks
# in `$OPENSSL35`, then `~/tools/ossl`, then `/tmp/ossl`, and says on stderr what is not being checked when
# it finds none of them.
#
#   sh tools/openssl35.sh
set -e
DIR="${OPENSSL35_DIR:-$HOME/tools/ossl}"
VER=3.5.7
mkdir -p "$DIR"
cd "$DIR"
if [ -x "$DIR/openssl-openssl-$VER/apps/openssl" ]; then
  echo "already built: $DIR/openssl-openssl-$VER/apps/openssl"
  exit 0
fi
[ -f openssl.tar.gz ] || curl -sL -o openssl.tar.gz \
  "https://github.com/openssl/openssl/archive/refs/tags/openssl-$VER.tar.gz"
tar xzf openssl.tar.gz
cd "openssl-openssl-$VER"
./Configure --prefix="$DIR/inst" --openssldir="$DIR/inst/ssl" no-shared no-docs no-tests > /dev/null
make -j"$(nproc)" > /dev/null
echo "built: $PWD/apps/openssl"
"$PWD/apps/openssl" version
