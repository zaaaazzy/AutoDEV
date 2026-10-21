# Installationsskripte: Geheimnisse und Plist-Escaping (21.10.2026)

Auftrag 1e856466, Bugfix aus dem Code-Review vom 20.10.2026. Anleitung für Anwender: `docs/installation.md`, Abschnitte „Hintergrunddienste und Zugänge“ und „Container-Härtung“.

## Problem

- Plist und systemd-Unit entstanden per Heredoc ohne XML-Escaping. Ein Passwort mit `&` ergab eine ungültige Plist, `launchctl bootstrap` scheiterte.
- DB-URL und Secret Key standen in Dateien mit Rechten 644, also für andere lokale Benutzer lesbar.
- `install-worker.ps1` schrieb die DB-URL samt Passwort in die Befehlszeile der geplanten Aufgabe.
- Container ohne Limits und teils ohne Healthcheck, nginx/Caddy/Backup/Review als root, Standardpasswort `devlog_local_dev` ohne Warnung, `playwright` in `dependencies`.

## Umsetzung

- **Env-Datei statt Zugänge in Plist/Unit/Befehlszeile.** Die Installationsskripte schreiben `DEV_LOG_DATABASE_URL` und `DEV_LOG_SECRET_KEY` in eine Datei mit Rechten 600 (Windows: ACL nur für den Benutzer). Gemeinsame Hilfen stehen in `scripts/lib/service-env.sh`.
- **Wrapper beim Start.** `scripts/run-with-env.sh` und `run-with-env.ps1` laden die Datei. Fehlt sie oder ist sie für andere lesbar, bricht der Dienst mit klarer Meldung im Log ab, statt ohne Zugänge zu starten.
- **Plist/Unit ohne Geheimnisse**, mit Rechten 600 und escapten Werten. Ein erneuter Lauf ersetzt alte Dateien bzw. die alte Windows-Aufgabe.
- **Standardpasswort-Warnung** in `src/core/default-credentials.ts`, aufgerufen aus `src/db/database.ts` und `src/runner/watchdog-cli.ts` sowie in den Skripten und in `scripts/setup/server.ts`. Die URL selbst wird nicht ausgegeben.
- **`docker-compose.yml`:** Limits für Speicher, CPU und Prozesse, Healthchecks für Caddy und Backup, `cap_drop: [ALL]` und `no-new-privileges`. nginx läuft als `nginx` auf Port 8080, Caddy als `caddy` (eigenes Image `deploy/caddy/Dockerfile`, nur `NET_BIND_SERVICE`), Backup als `70:70` (überschreibbar mit `DEV_LOG_BACKUP_USER`), Review-Container als `node`. Der einmalige Dienst `https-volumes` übergibt bestehende Zertifikats-Volumes an `caddy`.
- **`package.json`:** `playwright` aus `dependencies` verschoben.

## Geänderte Dateien

- Skripte: `scripts/install-worker.sh`, `install-watchdog.sh`, `install-worker-linux.sh`, `install-worker.ps1`, `scripts/run-with-env.sh`, `run-with-env.ps1`, `scripts/lib/service-env.sh`, `scripts/setup/server.ts`
- Container: `docker-compose.yml`, `deploy/caddy/Dockerfile`, `deploy/frontend/Dockerfile`, `deploy/backup.sh`, `deploy/review/Dockerfile`, `deploy/review/entrypoint.sh`, `src/runner/review-slots.ts`
- Code: `src/core/default-credentials.ts`, `src/db/database.ts`, `src/runner/watchdog-cli.ts`
- Tests: `src/core/default-credentials.test.ts`, `src/setup/install-scripts.test.ts`
- Doku und Abhängigkeiten: `docs/installation.md`, `docs/agents-und-rechte.md`, `README.md`, `package.json`, `package-lock.json`

## Tests

`npm run typecheck` und 13 Tests (`default-credentials`, `review-slots`, `install-scripts`) sind grün. Die Plist-Tests (`plutil -lint`, Rechte 600) laufen nur auf macOS, der PowerShell-Test nur mit installiertem `pwsh`.

## Worauf zu achten ist

- **Container-Härtung ist nicht gestartet.** Docker ist für Agents gesperrt. Ein Mensch muss vor dem Merge `docker compose config` ausführen und den Stack mit Profil `https` starten. Zu prüfen sind nginx als Non-Root auf Port 8080, Caddy mit `cap_drop`, `https-volumes` und der Backup-Healthcheck.
- **Abdeckung nicht gemessen** (`--experimental-test-coverage` ist für Agents gesperrt).
- **Bestehende Installationen:** Skript einmal erneut ausführen. Wurde das DB-Passwort früher in Plist oder Unit gespeichert, sollte es geändert werden.
- **Linux-Backup:** `./backups` muss für `70:70` beschreibbar sein, sonst `DEV_LOG_BACKUP_USER=<uid>:<gid>` in der `.env` setzen.
- **Änderungen an `docker-compose.yml`** können mit anderen Aufträgen des Sprints kollidieren. Vor dem Merge rebasen.
