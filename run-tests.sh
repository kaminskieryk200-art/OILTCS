#!/usr/bin/env bash
# JVM tests only; no Android, real BLE radio or real accounts.
set -euo pipefail
cd "$(dirname "$0")"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
javac -encoding UTF-8 -d "$TMP" $(find src/main/java src/test/java -name '*.java' -print)
for test in OiltcsRouterTest BleFrameCodecLabTest CertifiedContactAuthorizationLabTest WireVectorTest; do java -cp "$TMP" "$test"; done
if command -v node >/dev/null; then
  node --check experiments/identity/issuer-lab.mjs
  # warstwa aplikacji: stacje ładujące sygnał, deduplikacja, brak pętli (bez radia)
  for f in tools/*.js; do node --check "$f"; done
  node tools/stations-selftest.mjs
  node tools/signing-selftest.mjs
  node tools/verify-selftest.mjs
  node tools/distance-verify-selftest.mjs
fi
