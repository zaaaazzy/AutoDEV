# AIdeation starten (Windows): prüft Node und Docker, richtet beim ersten Start alles über den Browser-Assistenten ein.
param([switch]$Setup)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

function Need($command, $hint) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { Write-Host "x $command fehlt. $hint"; exit 1 }
}
Need node 'Bitte Node.js 22.12 oder neuer installieren: https://nodejs.org/'
Need npm 'npm gehoert zu Node.js - bitte Node.js neu installieren: https://nodejs.org/'
Need docker 'Bitte Docker Desktop installieren und starten: https://docs.docker.com/get-docker/'
# 22.12: Mindestversion von Angular 20 und Vite 8 (Projektvorlage fuer Browser-Spiele).
$nodeVersion = [version](node -p "process.versions.node")
if ($nodeVersion -lt [version]'22.12.0') { Write-Host "x Node.js $nodeVersion ist zu alt - bitte Version 22.12 oder neuer."; exit 1 }
docker info *> $null
if ($LASTEXITCODE -ne 0) { Write-Host 'x Docker laeuft nicht - bitte Docker Desktop starten.'; exit 1 }
docker compose version *> $null
if ($LASTEXITCODE -ne 0) { Write-Host 'x Docker Compose (docker compose) fehlt - bitte Docker Desktop aktualisieren.'; exit 1 }
# Native Befehle setzen nur $LASTEXITCODE, $ErrorActionPreference greift bei ihnen nicht (Windows PowerShell 5.1).
if (-not (Test-Path node_modules)) {
  Write-Host '-> Installiere Abhaengigkeiten (einmalig) ...'
  npm ci
  if ($LASTEXITCODE -ne 0) { Write-Host 'x npm ci ist fehlgeschlagen.'; exit 1 }
}
New-Item -ItemType Directory -Force -Path backups | Out-Null
# Chromium fuer Playwright (optische Abnahme, Smoke-Test der Phaser-Vorlage); ist er da, ist das schnell fertig.
npx --no-install playwright install chromium
if ($LASTEXITCODE -ne 0) { Write-Host '! Chromium konnte nicht geladen werden - spaeter: npx playwright install chromium' }

if (-not (Test-Path .env) -or $Setup -or $args -contains '--setup') {
  Write-Host '-> Starte den Einrichtungs-Assistenten ...'
  npx tsx scripts/setup/server.ts
  exit $LASTEXITCODE
}

Write-Host '-> Starte AIdeation ...'
# Worker im Container (COMPOSE_PROFILES=worker): AIdeation-Ordner und Projektordner im Pfad von Docker Desktop
# (C:\... -> /c/...) und Git-Zugaenge aus der .env in docker-compose.override.yml.
npx --no-install tsx scripts/worker-compose.ts
if ($LASTEXITCODE -ne 0) { Write-Host 'x docker-compose.override.yml konnte nicht geschrieben werden.'; exit 1 }
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { Write-Host 'x docker compose up ist fehlgeschlagen.'; exit 1 }
# Image der Agents (Sandbox): fehlt es, scheitert jeder Agent-Lauf mit "Image fehlt".
docker image inspect aideation-agent *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host '-> Baue das Agent-Image (einmalig, einige Minuten) ...'
  docker build -t aideation-agent -f deploy/agent/Dockerfile .
  if ($LASTEXITCODE -ne 0) { Write-Host '! Agent-Image nicht gebaut - spaeter: docker build -t aideation-agent -f deploy/agent/Dockerfile .' }
}
$healthy = $false
for ($i = 0; $i -lt 60; $i++) {
  try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3100/health -TimeoutSec 2 | Out-Null; $healthy = $true; break } catch { Start-Sleep 2 }
}
if (-not $healthy) { Write-Host 'x AIdeation antwortet nicht - "docker compose logs dev-log" zeigt den Grund.'; exit 1 }
Write-Host 'OK AIdeation laeuft: http://localhost:3100'
Start-Process 'http://localhost:3100'
