# Installiert den AIdeation-Worker unter Windows als geplante Aufgabe (Start bei Anmeldung).
# Zugänge (DEV_LOG_DATABASE_URL, DEV_LOG_SECRET_KEY) stehen in %LOCALAPPDATA%\AIdeation\worker.env (ACL nur für den
# Benutzer), nicht in der Befehlszeile der Aufgabe; scripts\run-with-env.ps1 liest sie beim Start.
# Zeichenketten nur ASCII: Windows PowerShell 5.1 liest Skripte ohne BOM nicht als UTF-8.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dir = Join-Path $env:LOCALAPPDATA 'AIdeation'
$envFile = Join-Path $dir 'worker.env'
$onWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT

# Nur der aktuelle Benutzer (per SID) hat Zugriff, geerbte Rechte werden entfernt.
function Protect-Path([string]$Path, [string]$Grant) {
  if (-not $onWindows) { return }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls $Path /inheritance:r /grant:r "*${sid}:$Grant" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Rechte fuer $Path konnten nicht gesetzt werden." }
}

# Letzter Wert von $Key in der bestehenden Env-Datei (erneuter Lauf behält die Zugänge).
function Get-EnvFileValue([string]$Key) {
  if (-not (Test-Path -LiteralPath $envFile)) { return '' }
  $value = ''
  foreach ($line in [IO.File]::ReadAllLines($envFile)) {
    if ($line.StartsWith("$Key=")) { $value = $line.Substring($Key.Length + 1) }
  }
  return $value
}

function Resolve-Value([string]$Key, [string]$Default = '') {
  $value = [Environment]::GetEnvironmentVariable($Key)
  if (-not $value) { $value = Get-EnvFileValue $Key }
  if (-not $value) { $value = $Default }
  return $value
}

$values = [ordered]@{
  DEV_LOG_DATABASE_URL = Resolve-Value 'DEV_LOG_DATABASE_URL' 'postgresql://devlog:devlog_local_dev@localhost:5433/aideation'
  DEV_LOG_SECRET_KEY = Resolve-Value 'DEV_LOG_SECRET_KEY'
}
if ($values.DEV_LOG_DATABASE_URL.Contains('devlog_local_dev')) {
  Write-Warning 'Die Datenbank-URL nutzt das Standardpasswort devlog_local_dev. Setze DEV_LOG_DB_PASSWORD in der .env und installiere mit DEV_LOG_DATABASE_URL erneut (siehe docs/installation.md).'
}
$lines = @('# AIdeation - Zugaenge fuer den Worker (erzeugt von scripts\install-worker.ps1, nur fuer diesen Benutzer lesbar).')
foreach ($key in $values.Keys) {
  $value = [string]$values[$key]
  if ($value -match "[`r`n]") { throw "Wert fuer $key enthaelt einen Zeilenumbruch - nicht erlaubt." }
  if ($value) { $lines += "$key=$value" }
}

# Erst Ordner und leere Datei schützen, dann schreiben: der Inhalt ist nie für andere lesbar.
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Protect-Path $dir '(OI)(CI)F'
if (-not (Test-Path -LiteralPath $envFile)) { New-Item -ItemType File -Path $envFile | Out-Null }
Protect-Path $envFile 'F'
[IO.File]::WriteAllText($envFile, ($lines -join "`n") + "`n", (New-Object Text.UTF8Encoding($false)))

$wrapper = Join-Path (Join-Path $root 'scripts') 'run-with-env.ps1'
$arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wrapper`" `"$envFile`" npm run worker"
# Neustart nach "AIdeation neu starten" (Exit-Code 75) uebernimmt die Schleife in run-with-env.ps1.
# Bewusst ohne RestartCount: Ein bewusster Stopp oder echter Fehler (Exit-Code ungleich 75) soll den Worker nicht neu
# starten. Kein Zeitlimit (Standard waeren 72 Stunden, danach beendet die Aufgabenplanung den Worker).
$settings = [ordered]@{
  ExecutionTimeLimit = [TimeSpan]::Zero
  MultipleInstances = 'IgnoreNew'
}
if ($env:AIDEATION_INSTALL_DRY_RUN -eq '1') {
  Write-Host "Probelauf: $envFile geschrieben, Aufgabe nicht registriert."
  Write-Host "Aufgabe: powershell.exe $arguments"
  foreach ($key in $settings.Keys) { Write-Host "Einstellung: $key=$($settings[$key])" }
  exit 0
}
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$taskSettings = New-ScheduledTaskSettingsSet @settings -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'AIdeationWorker' -Action $action -Trigger $trigger -Settings $taskSettings -RunLevel Limited -Force | Out-Null
Start-ScheduledTask -TaskName 'AIdeationWorker'
Write-Host "Worker installiert (Aufgabenplanung: AIdeationWorker, Zugaenge: $envFile)"
