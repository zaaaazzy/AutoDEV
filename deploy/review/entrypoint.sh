#!/bin/sh
set -eu
: "${REVIEW_COMMIT:?REVIEW_COMMIT fehlt}"
: "${REVIEW_COMMAND:?REVIEW_COMMAND fehlt}"
echo "[review] Stand ${REVIEW_COMMIT} (${REVIEW_LABEL:-ohne Titel})"
# Leeres Repository, das die eingebundenen Objekte mitliest (nichts wird kopiert, kein Zugriff auf den Projektordner).
find /work -mindepth 1 -delete
git init --quiet /work
echo /source/objects > /work/.git/objects/info/alternates
cd /work
git checkout --quiet --detach "$REVIEW_COMMIT"
if [ -f package-lock.json ]; then
  echo "[review] Abhängigkeiten installieren (npm ci)"
  npm ci --no-audit --no-fund --prefer-offline
fi
echo "[review] Start: ${REVIEW_COMMAND}"
exec sh -c "$REVIEW_COMMAND"
