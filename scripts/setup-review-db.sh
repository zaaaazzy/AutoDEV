#!/bin/bash
# Richtet den Datenbank-User für Review-Container ein (einmalig, idempotent). Der User ist kein Superuser, darf nur
# eigene Datenbanken anlegen (aideation_review, aideation_review_<n>) und kommt nicht an „aideation“ oder „postgres“.
# Danach den ausgegebenen Wert als DEV_LOG_REVIEW_DATABASE_URL beim Installieren des Workers setzen, z. B.
#   DEV_LOG_REVIEW_DATABASE_URL=… ./scripts/install-worker.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ADMIN_USER="${DEV_LOG_DB_USER:-devlog}"
REVIEW_USER="${DEV_LOG_REVIEW_DB_USER:-aideation_review}"
REVIEW_PASSWORD="${DEV_LOG_REVIEW_DB_PASSWORD:-$(openssl rand -hex 24)}"
case "$REVIEW_USER" in
  "$ADMIN_USER" | postgres) echo "Review-User muss ein eigener User sein." >&2; exit 1 ;;
esac
[[ "$REVIEW_USER" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "Ungültiger User-Name: $REVIEW_USER" >&2; exit 1; }
psql_admin() { docker compose -f "$ROOT/docker-compose.yml" exec -T db psql -v ON_ERROR_STOP=1 -U "$ADMIN_USER" "$@"; }
psql_admin -d aideation -v user="$REVIEW_USER" -v password="$REVIEW_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'user') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'user') \gexec
SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER CREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'user', :'password') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'user', :'user') WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'user') \gexec
-- Standardmässig darf jeder User sich mit jeder Datenbank verbinden: für die Haupt-Datenbanken abschalten.
REVOKE CONNECT ON DATABASE aideation FROM PUBLIC;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
SQL
echo "DEV_LOG_REVIEW_DATABASE_URL=postgresql://$REVIEW_USER:$REVIEW_PASSWORD@localhost:5433/$REVIEW_USER"
