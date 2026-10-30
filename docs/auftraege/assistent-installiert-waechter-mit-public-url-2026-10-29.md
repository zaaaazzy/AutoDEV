# Assistent installiert Wächter mit DEV_LOG_PUBLIC_URL

Auftrag d78bcb67 (Bugfix, Sprint 28). Gefunden bei der Gesamtprüfung vom 21.10.2026 (Bereich deploy, Schwere niedrig).

## Problem

- Bei Einrichtung mit eigener Domain schrieb der Assistent `DEV_LOG_PUBLIC_URL` in die Konfigurationsdatei. Vor `install-watchdog.sh` setzte `scripts/setup/server.ts` aber nur `DEV_LOG_DATABASE_URL` und `DEV_LOG_SECRET_KEY` in die Umgebung.
- Das Skript schreibt die URL aus der Umgebung nach `watchdog.env`. Sie blieb leer, der Wächter prüfte die HTTPS-Adresse nie und meldete kein abgelaufenes Zertifikat.

## Umsetzung

- `src/core/env-file.ts`: Neu sind `SERVICE_INSTALL_KEYS` (DB-URL, Secret Key, öffentliche URL) und `applyServiceInstallEnv(values, target = process.env)`. Fehlende oder leere Werte werden aus der Umgebung gelöscht, statt als „undefined“ gesetzt zu werden. So geht keine alte Domain aus einer früheren Sitzung an die Skripte.
- `scripts/setup/server.ts`: Die beiden Einzelzuweisungen sind durch `applyServiceInstallEnv(env)` ersetzt. Das gilt für Worker und Wächter auf macOS, Linux und Windows. Es gibt nur noch eine Liste.
- `src/core/env-file.test.ts`: Zwei Regressionstests. Mit Domain kommt `DEV_LOG_PUBLIC_URL=https://<domain>` samt DB-URL und Secret Key an. Ohne Domain wird ein alter Wert entfernt, andere Variablen bleiben.

## Worauf zu achten ist

- Die Plist enthält selbst keine Variablen. `install-watchdog.sh` schreibt die URL nach `watchdog.env`, die Plist lädt diese Datei per `--env-file`. Das Akzeptanzkriterium „Plist enthält die URL“ ist damit über `watchdog.env` erfüllt. Das Shell-Skript blieb unverändert.
- Der Test „macOS-Wächter: Plist wohlgeformt, Rechte 600, ohne Datenbank-URL“ in `src/setup/install-scripts.test.ts` läuft nur auf macOS.
- Neue Werte für die Installationsskripte gehören in `SERVICE_INSTALL_KEYS`, nicht als Einzelzuweisung in `server.ts`.
- Der Entwickler konnte Tests und ESLint nicht ausführen; nur `tsc --noEmit` lief fehlerfrei. Der Tester soll `env-file.test.ts` und `install-scripts.test.ts` laufen lassen.
- Die „offenen“ Bug-Wächter-Einträge („monthly spend limit“) sind reine Kostenlimit-Abbrüche und haben mit diesem Code nichts zu tun.

## Geänderte Dateien

- `scripts/setup/server.ts`
- `src/core/env-file.ts`
- `src/core/env-file.test.ts`

Datenbank, API und Oberfläche sind unverändert.
