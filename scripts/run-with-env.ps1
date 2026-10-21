# Startet den Worker unter Windows mit den Zugängen aus einer geschützten Env-Datei (aus der geplanten Aufgabe).
# Aufruf: powershell -File scripts\run-with-env.ps1 <env-datei> <befehl> [argumente ...]
# Zeilen KEY=Wert, nichts wird ausgewertet. Fehlt die Datei, bricht der Start mit Fehler ab.
# Zeichenketten nur ASCII: Windows PowerShell 5.1 liest Skripte ohne BOM nicht als UTF-8.
$ErrorActionPreference = 'Stop'
if ($args.Count -lt 2) {
  [Console]::Error.WriteLine('Aufruf: run-with-env.ps1 <env-datei> <befehl> [argumente ...]')
  exit 64
}
$envFile = [string]$args[0]
$command = [string]$args[1]
$rest = @($args | Select-Object -Skip 2)
if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) {
  [Console]::Error.WriteLine("AIdeation: Env-Datei $envFile fehlt - scripts\install-worker.ps1 erneut ausfuehren.")
  exit 78
}
foreach ($line in [IO.File]::ReadAllLines($envFile)) {
  $line = $line.TrimEnd("`r")
  if ($line -eq '' -or $line.StartsWith('#')) { continue }
  $index = $line.IndexOf('=')
  $key = if ($index -gt 0) { $line.Substring(0, $index) } else { '' }
  if ($key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
    [Console]::Error.WriteLine("AIdeation: ungueltige Zeile in $envFile (erwartet KEY=Wert).")
    exit 78
  }
  [Environment]::SetEnvironmentVariable($key, $line.Substring($index + 1), 'Process')
}
& $command @rest
exit $LASTEXITCODE
