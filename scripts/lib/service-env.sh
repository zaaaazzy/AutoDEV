# Gemeinsame Helfer der Installationsskripte (install-worker.sh, install-watchdog.sh, install-worker-linux.sh).
# Zugänge (Datenbank-URL, Schlüssel) stehen nie in Plist oder Unit, sondern in einer Env-Datei mit Rechten 600;
# scripts/run-with-env.sh liest sie beim Start. Diese Datei wird mit `source` eingebunden.

# Ordner für die Env-Dateien der Dienste (nur für den Benutzer lesbar).
SERVICE_ENV_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/aideation"

# .env der Installation (vom Einrichtungs-Assistenten geschrieben); ROOT setzt das einbindende Skript.
PROJECT_ENV_FILE="${ROOT:+$ROOT/.env}"

# AIDEATION_INSTALL_DRY_RUN=1: nur Dateien schreiben, Dienst nicht registrieren (Tests).
install_dry_run() { [ "${AIDEATION_INSTALL_DRY_RUN:-}" = "1" ]; }

# Letzter Wert von <schluessel> in der Env-Datei eines Dienstes <datei> (leer, wenn Datei oder Schlüssel fehlt).
# Diese Dateien schreibt write_env_file unverändert, ohne Anführungszeichen – darum hier keine Auswertung.
env_file_get() {
  local file="$1" key="$2" line value=""
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in "$key="*) value="${line#"$key="}" ;; esac
  done <"$file"
  printf '%s' "$value"
}

# Letzter Wert von <schluessel> in der .env <datei>, nach denselben Regeln wie parseEnv (src/core/env-file.ts):
# „export “ erlaubt, Kommentarzeilen übersprungen, Wert in '…' oder "…" ohne die Zeichen, sonst ohne „ #Kommentar“.
dotenv_get() {
  local file="$1" key="$2" line value="" found=""
  local pattern='^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$'
  [ -n "$file" ] && [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "${line#"${line%%[![:space:]]*}"}" in '#'*) continue ;; esac
    [[ "$line" =~ $pattern ]] && [ "${BASH_REMATCH[2]}" = "$key" ] || continue
    found="${BASH_REMATCH[3]}"
    found="${found#"${found%%[![:space:]]*}"}"
    found="${found%"${found##*[![:space:]]}"}"
    if [ "${#found}" -ge 2 ] && { [[ "$found" == \'*\' ]] || [[ "$found" == \"*\" ]]; }; then
      value="${found:1:${#found}-2}"
    else
      value="${found%%[[:space:]]#*}"
      value="${value%"${value##*[![:space:]]}"}"
    fi
  done <"$file"
  printf '%s' "$value"
}

# Wert für <schluessel>: Umgebung vor .env der Installation vor bestehender Env-Datei des Dienstes vor <standard>.
# Die .env geht vor: Setzt der Einrichtungs-Assistent ein neues DB-Passwort, übernimmt ein erneuter Lauf es.
resolve_value() {
  local key="$1" file="$2" fallback="${3:-}" value
  value="${!key:-}"
  [ -n "$value" ] || value="$(dotenv_get "$PROJECT_ENV_FILE" "$key")"
  [ -n "$value" ] || value="$(env_file_get "$file" "$key")"
  printf '%s' "${value:-$fallback}"
}

# Bricht ab (ohne den Wert auszugeben), wenn die Datenbank-URL fehlt oder das öffentlich bekannte Standardpasswort
# nutzt – Worker und Server würden sich damit nicht anmelden bzw. den Start verweigern. Das Standardpasswort nur mit
# DEV_LOG_ALLOW_DEFAULT_DB_PASSWORD=1 (Wegwerf-Umgebung), dann mit Warnung.
require_database_url() {
  if [ -z "$1" ]; then
    echo "FEHLER: DEV_LOG_DATABASE_URL fehlt – weder in der Umgebung noch in der .env der Installation noch in der" \
      "Env-Datei des Dienstes. Erst ./start.sh --setup ausführen (schreibt die .env), dann erneut installieren" \
      "(siehe docs/installation.md)." >&2
    exit 1
  fi
  case "$1" in
    *devlog_local_dev*)
      if [ "${DEV_LOG_ALLOW_DEFAULT_DB_PASSWORD:-}" = "1" ]; then
        echo "WARNUNG: Die Datenbank-URL nutzt das Standardpasswort „devlog_local_dev“ (ausdrücklich erlaubt)." >&2
        return 0
      fi
      echo "FEHLER: Die Datenbank-URL nutzt das öffentlich bekannte Standardpasswort „devlog_local_dev“. Erst" \
        "./start.sh --setup ausführen (setzt DEV_LOG_DB_PASSWORD und ändert es in PostgreSQL), dann erneut installieren" \
        "(siehe docs/installation.md)." >&2
      exit 1
      ;;
  esac
}

# Schreibt stdin nach <datei> mit Rechten 600: erst in eine Temp-Datei (mktemp legt sie mit 600 an), dann umbenennen.
# Es gibt also keinen Moment, in dem der Inhalt für andere lesbar ist; eine alte Datei mit 644 wird ersetzt.
write_private_file() {
  local file="$1" dir tmp
  dir="$(dirname "$file")"
  mkdir -p "$dir"
  tmp="$(mktemp "$dir/.aideation.XXXXXX")"
  chmod 600 "$tmp"
  if ! cat >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$file"
}

# Schreibt die Env-Datei <datei> aus Paaren KEY=Wert (leere Werte entfallen). Format: eine Zeile KEY=Wert,
# nichts wird ausgewertet – Sonderzeichen wie & < > " ' % $ \ bleiben unverändert. Zeilenumbrüche sind verboten.
write_env_file() {
  local file="$1" pair
  shift
  (umask 077 && mkdir -p "$(dirname "$file")")
  chmod 700 "$(dirname "$file")"
  for pair in "$@"; do
    case "$pair" in
      *$'\n'* | *$'\r'*)
        echo "Wert für ${pair%%=*} enthält einen Zeilenumbruch – nicht erlaubt." >&2
        return 1
        ;;
    esac
  done
  {
    echo "# AIdeation – Zugänge für Hintergrunddienste (erzeugt von scripts/install-*.sh, Rechte 600)."
    for pair in "$@"; do
      if [ -n "${pair#*=}" ]; then printf '%s\n' "$pair"; fi
    done
  } | write_private_file "$file"
}

# XML-Escaping für Werte in einer Plist (& zuerst, sonst würde &lt; doppelt escapt).
xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

# Pfad für eine systemd-Einstellung ohne Anführungszeichen (WorkingDirectory=): nur Spezifizierer (%) verdoppeln.
systemd_path() {
  printf '%s' "${1//%/%%}"
}

# Ein Argument für ExecStart=/Environment= in doppelten Anführungszeichen: \ und " escapen, % verdoppeln;
# mit „exec“ als zweitem Argument zusätzlich $ verdoppeln (ExecStart= ersetzt sonst $VARIABLEN).
systemd_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  if [ "${2:-}" = "exec" ]; then value="${value//\$/\$\$}"; fi
  printf '"%s"' "$value"
}
