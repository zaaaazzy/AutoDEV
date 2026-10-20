# Installiert den AIdeation-Worker unter Windows als geplante Aufgabe (Start bei Anmeldung).
# URL und Secret Key stehen in einer Startdatei im Benutzerprofil (nicht im Aufgabenbefehl: der ist auf 261 Zeichen
# begrenzt und für andere Programme lesbar). PATH bleibt unverändert, damit der Worker die Agent-CLIs findet.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$database = if ($env:DEV_LOG_DATABASE_URL) { $env:DEV_LOG_DATABASE_URL } else { 'postgresql://devlog:devlog_local_dev@localhost:5433/aideation' }
# In .cmd-Dateien muss % verdoppelt werden (kommt in URL-kodierten Passwörtern vor).
function Escape-Cmd([string]$value) { $value.Replace('%', '%%') }
$dir = Join-Path $env:LOCALAPPDATA 'AIdeation'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$launcher = Join-Path $dir 'worker.cmd'
$lines = @('@echo off', "cd /d `"$root`"", "set `"DEV_LOG_DATABASE_URL=$(Escape-Cmd $database)`"")
if ($env:DEV_LOG_SECRET_KEY) { $lines += "set `"DEV_LOG_SECRET_KEY=$(Escape-Cmd $env:DEV_LOG_SECRET_KEY)`"" }
# Ausgaben ohne Umlaute: PowerShell 5.1 liest Skripte ohne BOM als ANSI.
else { Write-Host 'Hinweis: DEV_LOG_SECRET_KEY fehlt - verschluesselte Werte kann der Worker nicht lesen.' }
$lines += 'npm run worker'
Set-Content -Path $launcher -Value $lines -Encoding Default
schtasks /Create /F /SC ONLOGON /RL LIMITED /TN 'AIdeationWorker' /TR "`"$launcher`"" | Out-Null
schtasks /Run /TN 'AIdeationWorker' | Out-Null
Write-Host "Worker installiert (Aufgabenplanung: AIdeationWorker, Startdatei: $launcher)"
