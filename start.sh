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
need node "Bitte Node.js 22.12 oder neuer installieren: https://nodejs.org/"
need npm "npm gehört zu Node.js – bitte Node.js neu installieren: https://nodejs.org/"
need docker "Bitte Docker Desktop installieren und starten: https://docs.docker.com/get-docker/"
# 22.12: Mindestversion von Angular 20 und Vite 8 (Projektvorlage für Browser-Spiele).
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)'; then
  echo "✕ Node.js $(node -v) ist zu alt – bitte Version 22.12 oder neuer installieren."
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
elif [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  # Der Worker läuft mit diesen node_modules (nicht im Container): nach einem Update sonst ERR_MODULE_NOT_FOUND.
  echo "→ package-lock.json hat sich geändert – aktualisiere Abhängigkeiten …"
  npm ci
fi

# Chromium für Playwright (optische Abnahme, Smoke-Test der Phaser-Vorlage). Ist er da, ist das nach Sekunden fertig.
if ! npx --no-install playwright install chromium; then
  echo "! Chromium konnte nicht geladen werden – optische Abnahme und Spiel-Smoke-Tests fehlen bis „npx playwright install chromium“."
fi

if [ ! -f .env ] || [ "${1:-}" = "--setup" ]; then
  echo "→ Starte den Einrichtungs-Assistenten …"
  exec npx tsx scripts/setup/server.ts
fi

echo "→ Starte AIdeation …"
# Worker im Container (COMPOSE_PROFILES=worker): AIdeation-Ordner, Projektordner und Git-Zugänge aus der .env in
# docker-compose.override.yml – bei jedem Start neu, damit ein geänderter Projektbereich gilt.
npx --no-install tsx scripts/worker-compose.ts
docker compose up -d --build
# Image der Agents (Sandbox): fehlt es, scheitert jeder Agent-Lauf mit „Image fehlt“.
if ! docker image inspect aideation-agent >/dev/null 2>&1; then
  echo "→ Baue das Agent-Image (einmalig, einige Minuten) …"
  docker build -t aideation-agent -f deploy/agent/Dockerfile . || echo "! Agent-Image nicht gebaut – Agents starten erst nach „docker build -t aideation-agent -f deploy/agent/Dockerfile .“."
fi
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
