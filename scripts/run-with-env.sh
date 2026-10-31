#!/bin/bash
# Startet einen Hintergrunddienst (Worker, Wächter) mit den Zugängen aus einer geschützten Env-Datei.
# Aufruf (aus der systemd-Unit, scripts/install-worker-linux.sh): /bin/bash scripts/run-with-env.sh <env-datei> <befehl> [argumente …]
# Die Datei hat Zeilen KEY=Wert; nichts wird ausgewertet. Fehlt sie oder dürfen andere sie lesen, bricht der Start
# mit Fehler ab, statt still ohne Zugänge zu laufen.
set -euo pipefail
ENV_FILE="${1:-}"
if [ -z "$ENV_FILE" ] || [ "$#" -lt 2 ]; then
  echo "Aufruf: run-with-env.sh <env-datei> <befehl> [argumente …]" >&2
  exit 64
fi
shift
if [ ! -f "$ENV_FILE" ]; then
  echo "AIdeation: Env-Datei $ENV_FILE fehlt – Installationsskript (scripts/install-*.sh) erneut ausführen." >&2
  exit 78
fi
if [ ! -O "$ENV_FILE" ]; then
  echo "AIdeation: $ENV_FILE gehört nicht dem aktuellen Benutzer – Start abgebrochen." >&2
  exit 78
fi
# GNU stat (Linux) zuerst; auf macOS schlägt -c fehl und BSD stat liefert die Rechte.
mode="$(stat -c %a "$ENV_FILE" 2>/dev/null || stat -f %Lp "$ENV_FILE")"
if (((8#$mode & 8#077) != 0)); then
  echo "AIdeation: $ENV_FILE ist für andere lesbar (Rechte $mode) – mit „chmod 600“ schützen." >&2
  exit 78
fi
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  case "$line" in '' | '#'*) continue ;; esac
  key="${line%%=*}"
  if [ "$key" = "$line" ] || [[ ! "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    echo "AIdeation: ungültige Zeile in $ENV_FILE (erwartet KEY=Wert)." >&2
    exit 78
  fi
  export "$key=${line#*=}"
done <"$ENV_FILE"
exec "$@"
