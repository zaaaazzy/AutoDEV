#!/bin/sh
# Vorschau von AIdeation selbst im Review-Container (Projekt-Einstellung „Review-Befehl“:
#   sh deploy/review/aideation-review.sh – läuft im ausgecheckten Stand unter /work).
# Läuft ohne Anmeldung mit der eigenen, leeren Slot-Datenbank (aideation_review_<n>), die der Runner mit dem
# Review-DB-User anlegt (REVIEW_DATABASE_URL). Dieser User ist kein Superuser und kommt nur an aideation_review_*;
# der Container sieht weder die .env noch die Haupt-Zugänge noch die Datenbank „postgres“. Fehlt REVIEW_DATABASE_URL,
# bricht die Vorschau ab statt auf andere Zugänge auszuweichen. Erreichbar nur auf diesem Rechner (Port des Containers).
set -eu
: "${REVIEW_DATABASE_URL:?REVIEW_DATABASE_URL fehlt – im Runner DEV_LOG_REVIEW_DATABASE_URL einrichten (scripts/setup-review-db.sh)}"
export DEV_LOG_DATABASE_URL="$REVIEW_DATABASE_URL"
# Der Server prüft beim Start über diese Adresse, ob seine Datenbank existiert – hier die eigene, nie „postgres“.
export DEV_LOG_ADMIN_DATABASE_URL="$REVIEW_DATABASE_URL"
export DEV_LOG_AUTH=off
export DEV_LOG_HOST=0.0.0.0
export PORT="${REVIEW_FRONTEND_PORT:-4200}"

echo "[aideation-review] Oberfläche bauen"
npm run build:ui
echo "[aideation-review] Server auf :$PORT (Datenbank ${REVIEW_DATABASE_URL##*/})"
exec npx tsx src/server.ts
