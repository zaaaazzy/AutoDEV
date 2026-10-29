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

# Letzter Wert von $Key in der .env der Installation, nach denselben Regeln wie parseEnv (src/core/env-file.ts):
# "export " erlaubt, Kommentarzeilen uebersprungen, Wert in '...' oder "..." ohne die Zeichen, sonst ohne " #Kommentar".
function Get-DotEnvValue([string]$Key) {
  $file = Join-Path $root '.env'
  if (-not (Test-Path -LiteralPath $file)) { return '' }
  $value = ''
  foreach ($line in [IO.File]::ReadAllLines($file)) {
    if ($line.TrimStart().StartsWith('#')) { continue }
    $match = [regex]::Match($line, '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$')
    if (-not $match.Success -or $match.Groups[1].Value -cne $Key) { continue }
    $raw = $match.Groups[2].Value.Trim()
    if ($raw.Length -ge 2 -and ($raw[0] -eq "'" -or $raw[0] -eq '"') -and $raw.EndsWith([string]$raw[0])) {
      $value = $raw.Substring(1, $raw.Length - 2)
    } else {
      $value = $raw -replace '\s+#.*$', ''
    }
  }
  return $value
}

# Umgebung vor .env der Installation vor bestehender Env-Datei des Workers vor $Default.
function Resolve-Value([string]$Key, [string]$Default = '') {
  $value = [Environment]::GetEnvironmentVariable($Key)
  if (-not $value) { $value = Get-DotEnvValue $Key }
  if (-not $value) { $value = Get-EnvFileValue $Key }
  if (-not $value) { $value = $Default }
  return $value
}

$values = [ordered]@{
  DEV_LOG_DATABASE_URL = Resolve-Value 'DEV_LOG_DATABASE_URL'
  DEV_LOG_SECRET_KEY = Resolve-Value 'DEV_LOG_SECRET_KEY'
  # Eigener Ablageort der Playwright-Browser gilt auch fuer den Worker (Smoke-Tests der Spielprojekte, optische Abnahme).
  PLAYWRIGHT_BROWSERS_PATH = Resolve-Value 'PLAYWRIGHT_BROWSERS_PATH'
}
# Ohne Datenbank-URL oder mit dem bekannten Standardpasswort abbrechen: Der Worker koennte sich nicht anmelden.
if (-not $values.DEV_LOG_DATABASE_URL) {
  [Console]::Error.WriteLine('FEHLER: DEV_LOG_DATABASE_URL fehlt - weder in der Umgebung noch in der .env der Installation noch in worker.env. Erst ./start.sh --setup ausfuehren, dann erneut installieren (siehe docs/installation.md).')
  exit 1
}
if ($values.DEV_LOG_DATABASE_URL.Contains('devlog_local_dev')) {
  if ($env:DEV_LOG_ALLOW_DEFAULT_DB_PASSWORD -ne '1') {
    [Console]::Error.WriteLine('FEHLER: Die Datenbank-URL nutzt das Standardpasswort devlog_local_dev. Erst ./start.sh --setup ausfuehren (setzt DEV_LOG_DB_PASSWORD), dann erneut installieren (siehe docs/installation.md).')
    exit 1
  }
  Write-Warning 'Die Datenbank-URL nutzt das Standardpasswort devlog_local_dev (ausdruecklich erlaubt).'
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
