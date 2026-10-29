#!/bin/sh
# Start von Worker bzw. Ausfall-Wächter im Container (docker-compose.yml, Profil worker).
#   worker    Dauer-Worker für alle Projekte (wie „npm run worker“); Exit-Code 75 = Neustart nach dem Neubau.
#   watchdog  Prüflauf alle DEV_LOG_WATCHDOG_INTERVAL Sekunden (Standard 120).
# DEV_LOG_INSTALL_DIR (AIdeation-Ordner, gleicher Pfad wie auf dem Host) setzt docker-compose.override.yml.
set -eu
dir="${DEV_LOG_INSTALL_DIR:-}"
if [ -z "$dir" ] || [ ! -f "$dir/package.json" ]; then
  echo "AIdeation: AIdeation-Ordner nicht eingebunden (DEV_LOG_INSTALL_DIR=$dir) – docker-compose.override.yml fehlt." >&2
  echo "  Im AIdeation-Ordner „./start.sh“ bzw. „start.cmd“ ausführen (oder: npx tsx scripts/worker-compose.ts)." >&2
  exit 78
fi
cd "$dir"
tsx="node_modules/tsx/dist/cli.mjs"

case "${1:-worker}" in
  worker)
    # GitHub-Token (optional, schreibgeschützt eingebunden): nur für gh und Git dieses Prozesses, nie für Agent-Container.
    if [ -s /run/secrets/github_token ]; then
      GH_TOKEN="$(tr -d '\r\n' </run/secrets/github_token)"
      export GH_TOKEN
    fi
    # node_modules liegen in einem eigenen Volume (Linux-Binärdateien). Neu installieren, wenn sie fehlen oder das
    # Lockfile neuer ist; danach hält „AIdeation neu starten“ sie aktuell (src/runner/system-restart.ts).
    if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
      echo "→ Installiere die Abhängigkeiten des Workers (npm ci) …"
      npm ci --ignore-scripts
    fi
    exec node "$tsx" src/runner/runner-cli.ts --all --watch --limit 3
    ;;
  watchdog)
    interval="${DEV_LOG_WATCHDOG_INTERVAL:-120}"
    while :; do
      if [ -f "$tsx" ]; then
        node "$tsx" src/runner/watchdog-cli.ts && touch /tmp/aideation-watchdog.alive || true
      else
        echo "Wächter: node_modules fehlen noch – der Worker installiert sie gerade." >&2
      fi
      sleep "$interval"
    done
    ;;
  *)
    exec "$@"
    ;;
esac
