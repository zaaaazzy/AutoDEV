#!/bin/sh
set -eu
: "${REVIEW_COMMIT:?REVIEW_COMMIT fehlt}"
: "${REVIEW_COMMAND:?REVIEW_COMMAND fehlt}"
echo "[review] Stand ${REVIEW_COMMIT} (${REVIEW_LABEL:-ohne Titel})"
git config --global --add safe.directory '*'
# /work selbst gehört node und bleibt stehen (der Benutzer darf / nicht ändern); nur den Inhalt leeren.
find /work -mindepth 1 -maxdepth 1 -exec rm -rf {} +
# --shared: Objekte direkt aus dem eingebundenen Repository lesen (schnell, nichts wird kopiert).
git clone --quiet --no-checkout --shared /source /work
cd /work
git checkout --quiet --detach "$REVIEW_COMMIT"
if [ -f package-lock.json ]; then
  echo "[review] Abhängigkeiten installieren (npm ci)"
  npm ci --no-audit --no-fund --prefer-offline
fi
echo "[review] Start: ${REVIEW_COMMAND}"
exec sh -c "$REVIEW_COMMAND"
