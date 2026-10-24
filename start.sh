#!/usr/bin/env bash
# AIdeation starten (macOS und Linux).
#   Erster Start: richtet Abhängigkeiten ein und öffnet den Einrichtungs-Assistenten im Browser.
#   Danach: startet die Dienste und öffnet AIdeation.  ./start.sh --setup  öffnet den Assistenten erneut.
set -euo pipefail
cd "$(dirname "$0")"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "✕ $1 fehlt. $2"
    exit 1
  fi
}
need node "Bitte Node.js 22 oder neuer installieren: https://nodejs.org/"
need docker "Bitte Docker Desktop installieren und starten: https://docs.docker.com/get-docker/"
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "✕ Node.js $(node -v) ist zu alt – bitte Version 22 oder neuer installieren."
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "✕ Docker läuft nicht – bitte Docker Desktop starten und erneut versuchen."
  echo "  (Linux: läuft der Dienst docker? Ist dein Benutzer in der Gruppe docker?)"
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "✕ Docker Compose (docker compose) fehlt – bitte das Compose-Plugin installieren: https://docs.docker.com/compose/install/"
  exit 1
fi
# Sonst legt Docker den Backup-Ordner unter Linux als root an und der Backup-Container (ohne root) kann nicht schreiben.
mkdir -p backups
if [ ! -d node_modules ]; then
  echo "→ Installiere Abhängigkeiten (einmalig) …"
  npm ci
fi

if [ ! -f .env ] || [ "${1:-}" = "--setup" ]; then
  echo "→ Starte den Einrichtungs-Assistenten …"
  exec npx tsx scripts/setup/server.ts
fi

echo "→ Starte AIdeation …"
docker compose up -d --build
# Node statt curl: curl fehlt auf manchen Linux-Systemen, Node ist ohnehin Voraussetzung.
healthy=0
for _ in $(seq 1 60); do
  if node -e "fetch('http://127.0.0.1:3100/health',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; then
    healthy=1
    break
  fi
  sleep 2
done
if [ "$healthy" != 1 ]; then
  echo "✕ AIdeation antwortet nicht – „docker compose logs dev-log“ zeigt den Grund."
  exit 1
fi
URL="http://localhost:3100"
echo "✓ AIdeation läuft: $URL"
if command -v open >/dev/null 2>&1; then open "$URL"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true; fi
