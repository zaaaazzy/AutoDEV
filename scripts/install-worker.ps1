# Installiert den AIdeation-Worker unter Windows als geplante Aufgabe (Start bei Anmeldung).
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$database = if ($env:DEV_LOG_DATABASE_URL) { $env:DEV_LOG_DATABASE_URL } else { 'postgresql://devlog:devlog_local_dev@localhost:5433/aideation' }
$command = "cmd /c `"cd /d `"$root`" && set DEV_LOG_DATABASE_URL=$database && npm run worker`""
schtasks /Create /F /SC ONLOGON /RL LIMITED /TN 'AIdeationWorker' /TR $command | Out-Null
schtasks /Run /TN 'AIdeationWorker' | Out-Null
Write-Host 'Worker installiert (Aufgabenplanung: AIdeationWorker)'
