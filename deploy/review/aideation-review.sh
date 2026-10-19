#!/bin/sh
# Vorschau von AIdeation selbst im Review-Container (Projekt-Einstellung „Review-Befehl“:
#   sh /source/deploy/review/aideation-review.sh).
# Läuft ohne Anmeldung und mit einer eigenen, leeren Datenbank (aideation_review_<n>) – echte Daten, Zugänge und
# Schlüssel kommen nie in die Vorschau. Erreichbar nur auf diesem Rechner (Port des Review-Containers).
set -eu
env_value() { sed -n "s/^$1=//p" /source/.env 2>/dev/null | tail -n 1; }
DB_USER="${DEV_LOG_DB_USER:-$(env_value DEV_LOG_DB_USER)}"
DB_PASSWORD="${DEV_LOG_DB_PASSWORD:-$(env_value DEV_LOG_DB_PASSWORD)}"
DB_USER="${DB_USER:-devlog}"
DB_PASSWORD="${DB_PASSWORD:-devlog_local_dev}"
SLOT_DB="aideation_review_$(( ${REVIEW_PUBLIC_URL##*:} - 4200 ))"
export DEV_LOG_DATABASE_URL="postgresql://$DB_USER:$DB_PASSWORD@host.docker.internal:5433/$SLOT_DB"
export DEV_LOG_ADMIN_DATABASE_URL="postgresql://$DB_USER:$DB_PASSWORD@host.docker.internal:5433/postgres"
export DEV_LOG_AUTH=off
export DEV_LOG_HOST=0.0.0.0
export PORT="${REVIEW_FRONTEND_PORT:-4200}"

echo "[aideation-review] Oberfläche bauen"
npm run build:ui
echo "[aideation-review] Server auf :$PORT (Datenbank $SLOT_DB)"
exec npx tsx src/server.ts
