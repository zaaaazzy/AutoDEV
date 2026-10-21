# Gemeinsame Helfer der Installationsskripte (install-worker.sh, install-watchdog.sh, install-worker-linux.sh).
# Zugänge (Datenbank-URL, Schlüssel) stehen nie in Plist oder Unit, sondern in einer Env-Datei mit Rechten 600;
# scripts/run-with-env.sh liest sie beim Start. Diese Datei wird mit `source` eingebunden.

# Ordner für die Env-Dateien der Dienste (nur für den Benutzer lesbar).
SERVICE_ENV_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/aideation"

# Standard-Zugang aus docker-compose.yml (ohne DEV_LOG_DB_PASSWORD in der .env).
DEFAULT_DATABASE_URL="postgresql://devlog:devlog_local_dev@localhost:5433/aideation"

# AIDEATION_INSTALL_DRY_RUN=1: nur Dateien schreiben, Dienst nicht registrieren (Tests).
install_dry_run() { [ "${AIDEATION_INSTALL_DRY_RUN:-}" = "1" ]; }

# Letzter Wert von <schluessel> in <datei> (leer, wenn Datei oder Schlüssel fehlt).
env_file_get() {
  local file="$1" key="$2" line value=""
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in "$key="*) value="${line#"$key="}" ;; esac
  done <"$file"
  printf '%s' "$value"
}

# Wert für <schluessel>: Umgebung vor bestehender Env-Datei vor <standard>. So behält ein erneuter Lauf die Zugänge.
resolve_value() {
  local key="$1" file="$2" fallback="${3:-}" value
  value="${!key:-}"
  [ -n "$value" ] || value="$(env_file_get "$file" "$key")"
  printf '%s' "${value:-$fallback}"
}

# Warnt (ohne den Wert auszugeben), wenn die Datenbank-URL das öffentlich bekannte Standardpasswort nutzt.
warn_default_password() {
  case "$1" in
    *devlog_local_dev*)
      echo "WARNUNG: Die Datenbank-URL nutzt das Standardpasswort „devlog_local_dev“. Setze DEV_LOG_DB_PASSWORD in" \
        "der .env und installiere mit DEV_LOG_DATABASE_URL=… erneut (siehe docs/installation.md)." >&2
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
