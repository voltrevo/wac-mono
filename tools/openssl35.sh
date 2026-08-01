#!/bin/sh
# Build OpenSSL 3.5.7, which the tests use as a reference for SHAKE and ML-KEM.
#
# Ubuntu 24.04 ships OpenSSL 3.0.13, which predates both: ML-KEM arrived in 3.5 and
# `dgst -shake128 -xoflen` needs a modern enough dgst. www.openssl.org is not on this
# sandbox's proxy allowlist and github.com is, so this pulls the release tag from there.
#
# Takes about a minute on five cores. The result is used by tests that skip themselves
# when it is absent, so this is optional — it just narrows what they can check.
#
#   sh tools/openssl35.sh
set -e
DIR="${OPENSSL35_DIR:-/tmp/ossl}"
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
