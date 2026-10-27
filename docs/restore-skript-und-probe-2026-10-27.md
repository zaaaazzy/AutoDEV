# Restore-Skript und regelmässige Restore-Probe

Auftrag 6f5cee71 (Sprint 23). Aus dem Code-Review vom 21.10.2026 (Stand `a4971e9`).

## Problem

Das README empfahl `pg_restore --clean` gegen die laufende Datenbank. API, Worker und Wächter blieben dabei verbunden, und es fehlten `--if-exists`, `--exit-on-error` und `--single-transaction`. Im Ernstfall konnte so eine halb wiederhergestellte Datenbank zurückbleiben. Dass dafür derselbe `DEV_LOG_SECRET_KEY` nötig ist, stand nirgends. `backup_check` prüfte nur Alter und Grösse, nicht ob sich das Backup überhaupt einspielen lässt.

## Umsetzung

- **`scripts/restore.sh <dump>` (Ernstfall)**
  - Zuerst `pg_restore --list`. Ist das Backup unlesbar, bricht das Skript ab, bevor es etwas stoppt.
  - Danach eine Bestätigung: `WIEDERHERSTELLEN` eintippen, ohne Terminal `--yes`.
  - Es stoppt Worker und Wächter (launchd bzw. systemd, nur wenn installiert) sowie `dev-log`, `frontend` und `backup`. Der Backup-Dienst sichert damit keinen halben Stand und rotiert nichts.
  - Das Backup kommt mit `pg_restore --exit-on-error --single-transaction --no-owner` in die neue Datenbank `aideation_restore_<zeit>`. Danach folgt der Entschlüsselungs-Test.
  - Erst dann werden die Datenbanken umbenannt: `aideation` → `aideation_vor_restore_<zeit>`, die neue → `aideation`. Verbliebene Verbindungen trennt das Skript vorher.
  - Scheitert ein Schritt, löscht das Skript die neue Datenbank. Die Live-Datenbank bleibt unverändert, und die Dienste starten wieder (EXIT-Trap).
  - Kein `--clean` gegen die laufende Datenbank. Backups werden nur gelesen.
- **`scripts/restore.sh --probe <dump>`**
  - Läuft in einem eigenen Container `aideation_restore_probe_<zeit>` (postgres:17-alpine, Daten im RAM) auf `127.0.0.1:${RESTORE_PROBE_PORT:-5439}`, mit zufälligem Passwort, das nur über die Umgebung übergeben wird.
  - Prüft die Tabellen `projects` und `development_items`, macht den Entschlüsselungs-Test und löscht den Container in jedem Fall.
  - Abgelehnt werden als Ziel: Namen ohne Präfix `aideation_restore_probe_`, `aideation`, `aideation_dev`, `dev_log_e2e*`, Port 5433 und der Port aus `DEV_LOG_DATABASE_URL`.
- **Entschlüsselungs-Test** (`src/db/secret-key-check.ts`, CLI `secret-key-check-cli.ts`)
  - Liest alle verschlüsselten Werte: `projects.database_url`, TOTP in `users` und `app_settings`.
  - Gibt nur Anzahlen je Stelle aus, nie Schlüssel oder Klartext.
  - Der Schlüssel kommt aus der Umgebung, sonst aus `.env`, sonst aus `worker.env`. Weichen `.env` und `worker.env` voneinander ab, warnt das Skript, ohne die Werte zu zeigen.
- **`backup_check`**
  - Prüft zusätzlich `pg_restore --list` für das neueste Backup, mit mindestens einem Eintrag `TABLE DATA`.
  - Das Programm kommt aus `DEV_LOG_PG_RESTORE` (Umgebung des Workers), sonst `pg_restore` aus dem PATH.
  - Fehlendes Programm (ENOENT), kaputter Dump oder Dump ohne Daten ergeben `failed` mit benannter Meldung und Push. Die letzte stderr-Zeile von pg_restore steht in der Meldung.
  - Das Standard-Zeitlimit beträgt jetzt 60 s statt 20 s.
- **Neuer Job `restore_probe`**
  - Läuft wöchentlich, ist standardmässig an und hat ein Zeitlimit von 300 s.
  - Ruft `bash <AIdeation>/scripts/restore.sh --probe <neuestes Backup>` auf; der Pfad ist fest im Code, nichts kommt aus der Datenbank.
  - Erfolg: Die letzte Zeile des Skripts wird zur Meldung des Jobs. Fehlschlag: Die letzte stderr-Zeile landet in der Meldung, dazu ein Push.
  - Den Standardjob legt `src/db/schema.ts` idempotent an.
- **Doku:** README (Betrieb → Backups: Restore, Schlüssel, zweite Kopie ausser Haus), `docs/installation.md` (Abschnitt „Wiederherstellen“, Fehlerbehebung), `docs/wartungs-jobs.md`, `docs/laufzeit.md` und `docs/erm.md`.

## Tests

Die Tests laufen mit `npm test`:

- `scripts/restore.test.ts` führt das echte Skript mit einem Ersatz-`docker` und einem Ersatz-Schlüsseltest aus, ohne Docker und ohne Datenbank.
  - Fehlende Datei.
  - Abgelehnte Probe-Ziele: `aideation`, `dev_log_e2e`, fremder Name, Port 5433, Live-Port aus der URL.
  - Erfolgreiche Probe: eigener Port, `--exit-on-error --single-transaction`, Container wird gelöscht, kein `docker compose`.
  - Probe mit Fehlern in pg_restore, beim Schlüssel oder mit fremder Datenbank: Container weg, Backups unverändert.
  - Ernstfall ohne `--yes`: Es wird nichts gestoppt.
  - Ernstfall mit unlesbarem Dump: Abbruch vor dem Stoppen.
  - Erfolgreicher Ernstfall in der Reihenfolge stoppen → anlegen → einspielen → Schlüssel → umbenennen → starten, ohne `--clean`.
  - Fehler beim Einspielen oder Schlüssel: nichts umbenannt, neue Datenbank gelöscht, Dienste wieder gestartet.
  - In keinem Fall erscheint der Schlüssel in der Ausgabe.
- `src/db/secret-key-check.test.ts`: richtiger, falscher und fehlender Schlüssel. Die Meldung enthält weder Schlüssel noch Klartext.
- `src/runner/scheduler.test.ts`:
  - `backup_check` mit lesbarem Inhaltsverzeichnis, fehlendem `pg_restore`, kaputtem Dump und Dump ohne Daten, Push bei fehlendem Programm.
  - `restore_probe` mit Erfolg, Skriptfehler und fehlendem Backup (dann keine Probe).
  - Die Registry hat jetzt fünf Arten.

## Worauf zu achten ist

- Auf dem Worker-Rechner muss `pg_restore` ab Version 17 vorhanden sein. Bisher war es nicht nötig; ohne meldet `backup_check` ab jetzt bei jedem Lauf einen Fehler. macOS: `brew install libpq`, dann `DEV_LOG_PG_RESTORE=/opt/homebrew/opt/libpq/bin/pg_restore` in die `worker.env`.
- `restore_probe` braucht Docker auf dem Worker-Rechner und `DEV_LOG_SECRET_KEY` in der `worker.env`. Grosse Datenbanken können die 300 s überschreiten.
- Das Skript hat im Git-Index kein Ausführungsrecht (der Agent darf kein `chmod` aufrufen). Aufruf deshalb mit `bash scripts/restore.sh`; der Job macht das ebenso.
- Nicht gegen echtes Docker getestet. Ein Mensch sollte `bash scripts/restore.sh --probe backups/<neuestes>.dump` einmal laufen lassen. Den Ernstfall nur in einer Kopie der Installation ausprobieren.
- `aideation_vor_restore_<zeit>` bleibt nach einem Restore liegen. Nach der Prüfung von Hand löschen (Befehl steht in der Ausgabe).
- Die Backup-Rotation (`deploy/backup.sh`) ist unverändert.
