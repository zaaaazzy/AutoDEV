#!/bin/bash
# Spielt ein Backup von deploy/backup.sh (pg_dump -Fc) wieder ein.
#
#   scripts/restore.sh [--yes] backups/aideation-JJJJMMTT-HHMMSS.dump    Ernstfall: Live-Datenbank ersetzen
#   scripts/restore.sh --probe backups/aideation-JJJJMMTT-HHMMSS.dump    Probe in einer Wegwerf-Datenbank
#
# Ernstfall: Datei prüfen (pg_restore --list) → Worker, Wächter, API, Oberfläche und Backup-Dienst stoppen →
# in eine neue Datenbank aideation_restore_<zeit> einspielen (--exit-on-error, --single-transaction) →
# Schlüssel-Test mit DEV_LOG_SECRET_KEY → erst dann umbenennen: die bisherige Datenbank bleibt als
# aideation_vor_restore_<zeit> liegen, die neue heisst aideation → Dienste wieder starten. Scheitert ein Schritt vor
# dem Umbenennen, bleibt die Live-Datenbank unverändert und die Dienste starten wieder.
#
# Probe: eigener Container aideation_restore_probe_<zeit> (postgres:17-alpine, Daten im RAM) auf eigenem Port
# RESTORE_PROBE_PORT (Standard 5439, nur 127.0.0.1), danach gelöscht. Die Live-Datenbank und ihr Port 5433 sind als
# Ziel gesperrt. Läuft wöchentlich als Wartungs-Job restore_probe im Worker.
#
# Backups werden nur gelesen, nie gelöscht oder verschoben. DEV_LOG_SECRET_KEY wird nie ausgegeben; Quelle:
# Umgebung, sonst .env, sonst ~/.config/aideation/worker.env.
# Für Tests: RESTORE_KEY_CHECK ersetzt den Schlüssel-Test (Befehl ohne Argumente).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/service-env.sh
source "$ROOT/scripts/lib/service-env.sh"

LIVE_DB="aideation"
LIVE_PORT="5433"
PROBE_IMAGE="postgres:17-alpine"
PROBE_LABEL="aideation.restore-probe"
STAMP="$(date +%Y%m%d_%H%M%S)"

usage() {
  echo "Aufruf: scripts/restore.sh [--yes] <backup.dump>   (Ernstfall, ersetzt die Live-Datenbank)"
  echo "        scripts/restore.sh --probe <backup.dump>   (Probe in einer Wegwerf-Datenbank)"
}
die() {
  echo "Restore: $*" >&2
  exit 1
}
compose() { docker compose -f "$ROOT/docker-compose.yml" "$@"; }

MODE="live"
YES=0
FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --probe) MODE="probe" ;;
    --yes) YES=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*) die "Unbekannte Option „$1“." ;;
    *)
      [ -z "$FILE" ] || die "Nur eine Backup-Datei angeben."
      FILE="$1"
      ;;
  esac
  shift
done
if [ -z "$FILE" ]; then
  usage >&2
  exit 2
fi
[ -f "$FILE" ] && [ -r "$FILE" ] || die "Backup-Datei „$FILE“ fehlt oder ist nicht lesbar."
[ -s "$FILE" ] || die "Backup-Datei „$FILE“ ist leer."
command -v docker >/dev/null 2>&1 || die "docker nicht gefunden – Docker installieren bzw. in den PATH aufnehmen."

# Schlüssel nur in die Umgebung des Tests, nie auf die Kommandozeile oder in die Ausgabe.
secret_key() {
  local key
  key="$(resolve_value DEV_LOG_SECRET_KEY "$ROOT/.env")"
  [ -n "$key" ] || key="$(env_file_get "$SERVICE_ENV_DIR/worker.env" DEV_LOG_SECRET_KEY)"
  printf '%s' "$key"
}

# Entschlüsselungs-Test gegen <datenbank-url>: alle verschlüsselten Werte müssen lesbar sein.
key_check() {
  local url="$1" key
  key="$(secret_key)"
  if [ -n "${RESTORE_KEY_CHECK:-}" ]; then
    DEV_LOG_CHECK_DATABASE_URL="$url" DEV_LOG_SECRET_KEY="$key" "$RESTORE_KEY_CHECK"
    return
  fi
  [ -x "$ROOT/node_modules/.bin/tsx" ] || die "Schlüssel-Test nicht möglich: node_modules fehlt (npm ci im AIdeation-Ordner)."
  (cd "$ROOT" && DEV_LOG_CHECK_DATABASE_URL="$url" DEV_LOG_SECRET_KEY="$key" \
    "$ROOT/node_modules/.bin/tsx" src/db/secret-key-check-cli.ts)
}

# Port aus einer postgresql://-URL (Standard 5432).
url_port() {
  local rest="${1#*://}"
  rest="${rest#*@}"
  rest="${rest%%/*}"
  case "$rest" in *:*) printf '%s' "${rest##*:}" ;; *) printf '5432' ;; esac
}

# --- Probe ------------------------------------------------------------------------------------------------------

# Nur Wegwerf-Ziele: eigener Name mit festem Präfix, eigener Port, nie die Live-Datenbank oder ihr Port.
guard_probe_target() {
  local name="$1" port="$2" live_url
  case "$name" in
    "$LIVE_DB" | aideation_dev | dev_log_e2e*) die "„$name“ ist keine Wegwerf-Datenbank – Probe abgelehnt." ;;
  esac
  [[ "$name" =~ ^aideation_restore_probe_[a-z0-9_]{1,40}$ ]] ||
    die "Probe-Datenbank muss aideation_restore_probe_<name> heissen (nicht „$name“)."
  [[ "$port" =~ ^[0-9]{4,5}$ ]] && [ "$port" -ge 1024 ] && [ "$port" -le 65535 ] ||
    die "RESTORE_PROBE_PORT „$port“ ist kein gültiger Port."
  live_url="$(resolve_value DEV_LOG_DATABASE_URL "$SERVICE_ENV_DIR/worker.env" "$DEFAULT_DATABASE_URL")"
  if [ "$port" = "$LIVE_PORT" ] || [ "$port" = "$(url_port "$live_url")" ]; then
    die "Port $port gehört der Live-Datenbank – Probe abgelehnt."
  fi
}

# Global, weil der EXIT-Trap erst nach dem Ende von probe() läuft (lokale Variablen gibt es dann nicht mehr).
PROBE_CONTAINER=""
remove_probe() { [ -z "$PROBE_CONTAINER" ] || docker rm -f "$PROBE_CONTAINER" >/dev/null 2>&1 || true; }

probe() {
  local name="${RESTORE_PROBE_NAME:-aideation_restore_probe_$STAMP}" port="${RESTORE_PROBE_PORT:-5439}"
  local password summary tries=0 stale
  guard_probe_target "$name" "$port"
  PROBE_CONTAINER="$name"
  # Reste einer abgebrochenen Probe (gleiches Label) blockieren sonst den Port.
  stale="$(docker ps -aq --filter "label=$PROBE_LABEL" 2>/dev/null || true)"
  # shellcheck disable=SC2086
  [ -z "$stale" ] || docker rm -f $stale >/dev/null 2>&1 || true
  password="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  trap remove_probe EXIT
  trap 'exit 143' TERM INT
  echo "Probe: Wegwerf-Container $name auf 127.0.0.1:$port"
  # Passwort über die Umgebung, nicht auf der Kommandozeile.
  POSTGRES_PASSWORD="$password" docker run -d --rm --name "$name" --label "$PROBE_LABEL=1" \
    -e POSTGRES_PASSWORD -e POSTGRES_DB="$name" -p "127.0.0.1:$port:5432" \
    --tmpfs /var/lib/postgresql/data "$PROBE_IMAGE" >/dev/null ||
    die "Wegwerf-Container ließ sich nicht starten (Port $port belegt?)."
  # Über TCP prüfen: während der Initialisierung lauscht Postgres nur auf dem Socket.
  until docker exec "$name" pg_isready -q -h 127.0.0.1 -U postgres -d "$name" >/dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -lt 60 ] || die "Wegwerf-Datenbank wurde nicht bereit."
    sleep 1
  done
  docker exec -i "$name" pg_restore --exit-on-error --single-transaction --no-owner --no-acl \
    -U postgres -d "$name" <"$FILE" || die "Einspielen von $(basename "$FILE") fehlgeschlagen (pg_restore, siehe oben)."
  summary="$(docker exec "$name" psql -v ON_ERROR_STOP=1 -U postgres -d "$name" -tAc \
    "SELECT to_regclass('public.projects') IS NOT NULL AND to_regclass('public.development_items') IS NOT NULL,
            (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public')")" ||
    die "Eingespielte Datenbank lässt sich nicht abfragen."
  [ "${summary%%|*}" = "t" ] || die "Eingespielte Datenbank enthält keine AIdeation-Tabellen (projects, development_items)."
  key_check "postgresql://postgres:$password@127.0.0.1:$port/$name" ||
    die "Schlüssel-Test fehlgeschlagen – mit diesem DEV_LOG_SECRET_KEY wären die Projektzugänge nach einem Restore nicht lesbar."
  echo "Restore-Probe bestanden: $(basename "$FILE") vollständig eingespielt (${summary#*|} Tabellen), Schlüssel passt."
}

# --- Ernstfall ----------------------------------------------------------------------------------------------------

DB_USER=""
HOST_STOPPED=()

psql_admin() { compose exec -T db psql -v ON_ERROR_STOP=1 -q -U "$DB_USER" -d postgres "$@"; }

# Worker und Wächter laufen auf dem Host (launchd bzw. systemd --user); nur stoppen, was installiert ist.
stop_host_services() {
  local label plist
  for label in com.aideation.worker com.aideation.watchdog; do
    plist="$HOME/Library/LaunchAgents/$label.plist"
    if [ -f "$plist" ] && command -v launchctl >/dev/null 2>&1; then
      launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
      HOST_STOPPED+=("launchd:$plist")
    fi
  done
  if [ -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/aideation-worker.service" ] &&
    command -v systemctl >/dev/null 2>&1; then
    systemctl --user stop aideation-worker.service || true
    HOST_STOPPED+=("systemd:aideation-worker.service")
  fi
}

start_host_services() {
  local entry
  for entry in ${HOST_STOPPED[@]+"${HOST_STOPPED[@]}"}; do
    case "$entry" in
      launchd:*) launchctl bootstrap "gui/$(id -u)" "${entry#launchd:}" 2>/dev/null || true ;;
      systemd:*) systemctl --user start "${entry#systemd:}" || true ;;
    esac
  done
  HOST_STOPPED=()
}

start_services() {
  compose start backup dev-log frontend >/dev/null || echo "Restore: Dienste starten nicht – docker compose up -d" >&2
  start_host_services
}

confirm() {
  [ "$YES" = 1 ] && return
  [ -t 0 ] || die "Ersetzt die Live-Datenbank – ohne Terminal nur mit --yes."
  local answer
  echo "Die Live-Datenbank „$LIVE_DB“ wird durch $(basename "$FILE") ersetzt. API, Oberfläche, Worker, Wächter und"
  echo "Backup-Dienst werden dafür gestoppt. Die bisherige Datenbank bleibt als ${LIVE_DB}_vor_restore_$STAMP erhalten."
  read -r -p "Zum Fortfahren WIEDERHERSTELLEN eingeben: " answer
  [ "$answer" = "WIEDERHERSTELLEN" ] || die "Abgebrochen, nichts geändert."
}

restore_live() {
  local target="${LIVE_DB}_restore_$STAMP" previous="${LIVE_DB}_vor_restore_$STAMP" live_url check_url query=""
  DB_USER="$(resolve_value DEV_LOG_DB_USER "$ROOT/.env" devlog)"
  compose ps --status running --services 2>/dev/null | grep -qx db ||
    die "Datenbank-Dienst db läuft nicht – erst docker compose up -d db."
  compose exec -T db pg_restore --list <"$FILE" >/dev/null ||
    die "$(basename "$FILE") ist kein lesbares Backup (pg_restore --list scheitert) – nichts geändert."
  local key worker_key
  key="$(resolve_value DEV_LOG_SECRET_KEY "$ROOT/.env")"
  worker_key="$(env_file_get "$SERVICE_ENV_DIR/worker.env" DEV_LOG_SECRET_KEY)"
  if [ -n "$key" ] && [ -n "$worker_key" ] && [ "$key" != "$worker_key" ]; then
    echo "WARNUNG: DEV_LOG_SECRET_KEY in .env und worker.env unterscheiden sich – Worker und Dienst brauchen denselben." >&2
  fi
  confirm

  echo "Stoppe Worker, Wächter, API, Oberfläche und Backup-Dienst …"
  stop_host_services
  # Ab hier starten die Dienste in jedem Fall wieder, auch wenn ein Schritt scheitert.
  trap 'start_services' EXIT
  trap 'exit 143' TERM INT
  compose stop dev-log frontend backup >/dev/null

  psql_admin -c "CREATE DATABASE $target" || die "Datenbank $target ließ sich nicht anlegen – Live-Datenbank unverändert."
  echo "Spiele $(basename "$FILE") in $target ein …"
  if ! compose exec -T db pg_restore --exit-on-error --single-transaction --no-owner \
    -U "$DB_USER" -d "$target" <"$FILE"; then
    psql_admin -c "DROP DATABASE IF EXISTS $target" || true
    die "Einspielen fehlgeschlagen (siehe oben) – Live-Datenbank unverändert, Dienste starten wieder."
  fi

  live_url="$(resolve_value DEV_LOG_DATABASE_URL "$SERVICE_ENV_DIR/worker.env" "$DEFAULT_DATABASE_URL")"
  case "$live_url" in *\?*) query="?${live_url#*\?}" live_url="${live_url%%\?*}" ;; esac
  check_url="${live_url%/*}/$target$query"
  if ! key_check "$check_url"; then
    psql_admin -c "DROP DATABASE IF EXISTS $target" || true
    die "Schlüssel-Test fehlgeschlagen: Mit diesem DEV_LOG_SECRET_KEY wären die Projektzugänge nicht lesbar." \
      "Live-Datenbank unverändert. Den Schlüssel aus der Zeit des Backups in .env und worker.env setzen."
  fi

  # Verbliebene Verbindungen (z. B. Agent-Prozesse) trennen, dann in einem Zug umbenennen.
  psql_admin -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                  WHERE datname = '$LIVE_DB' AND pid <> pg_backend_pid()" >/dev/null || true
  psql_admin -c "ALTER DATABASE $LIVE_DB RENAME TO $previous" ||
    die "Umbenennen der Live-Datenbank gescheitert – sie ist unverändert; $target bleibt zur Prüfung liegen."
  if ! psql_admin -c "ALTER DATABASE $target RENAME TO $LIVE_DB"; then
    psql_admin -c "ALTER DATABASE $previous RENAME TO $LIVE_DB" || true
    die "Umbenennen von $target gescheitert – die bisherige Datenbank ist wieder aktiv."
  fi
  echo "Wiederhergestellt aus $(basename "$FILE"). Bisherige Datenbank: $previous"
  echo "Nach Prüfung entfernen: docker compose exec db dropdb -U $DB_USER $previous"
}

if [ "$MODE" = "probe" ]; then probe; else restore_live; fi
