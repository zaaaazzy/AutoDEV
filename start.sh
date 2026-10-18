#!/usr/bin/env bash
# Dev Log starten (macOS und Linux).
#   Erster Start: richtet Abhängigkeiten ein und öffnet den Einrichtungs-Assistenten im Browser.
#   Danach: startet die Dienste und öffnet Dev Log.  ./start.sh --setup  öffnet den Assistenten erneut.
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
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "→ Installiere Abhängigkeiten (einmalig) …"
  npm ci
fi

if [ ! -f .env ] || [ "${1:-}" = "--setup" ]; then
  echo "→ Starte den Einrichtungs-Assistenten …"
  exec npx tsx scripts/setup/server.ts
fi

echo "→ Starte Dev Log …"
docker compose up -d --build
for _ in $(seq 1 60); do
  curl -fsS http://127.0.0.1:3100/health >/dev/null 2>&1 && break
  sleep 2
done
URL="http://localhost:3100"
echo "✓ Dev Log läuft: $URL"
if command -v open >/dev/null 2>&1; then open "$URL"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true; fi
