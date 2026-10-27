# Wartungs-Jobs im Worker

Der Worker führt konfigurierbare Wartungsaufgaben zu festen Zeitpunkten aus. Die Zeitpläne stehen in der Tabelle `scheduled_jobs` und gelten ohne Neustart des Workers. Takt-Übersicht: `docs/laufzeit.md`, Spalten: `docs/erm.md`.

## Ablauf

1. `runner-cli.ts` ruft nach jedem Arbeitszyklus (30 s) `runScheduledJobs()` auf, ausserhalb von `runWorkflow`, weil dieses je Projekt läuft.
2. `runDueJobs` (`src/runner/scheduler.ts`) beansprucht fällige, aktive Zeilen mit `FOR UPDATE SKIP LOCKED`. Dabei setzt es `next_run_at` auf jetzt + Intervall, `locked_until` auf Zeitlimit + Reserve und `last_status` auf `running`. Ein zweiter Worker sieht die Zeile nicht und führt sie nicht doppelt aus.
3. Die Job-Art wird in der festen Registry `JOB_KINDS` nachgeschlagen. Unbekannte Art: Status `failed`, andere Jobs laufen weiter. Es wird nie ein Pfad oder Befehl aus der Datenbank ausgeführt.
4. Der Job läuft mit hartem Zeitlimit (`config.timeoutSeconds`, sonst Art-Standard, höchstens 300 s). Status, Zeitpunkt und Meldung werden in die Zeile zurückgeschrieben. Ein Fehler wird gespeichert und bricht weder den Durchgang noch den Worker-Zyklus ab.
5. Der Durchgang läuft im Hintergrund, höchstens einer gleichzeitig je Worker. Er zählt beim Neustart-Zähler (`busy`) mit und startet nicht mehr, sobald der Worker stoppt.

## Job-Arten

| Art                 | Prüft                                                                                                   | Konfiguration (Auswahl)                    |
| ------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `backup_check`      | Neuestes `aideation-*.dump` in `./backups`: jung genug, plausible Grösse und für `pg_restore --list` lesbar (mit Tabellendaten). Fehlender Ordner, fehlendes `pg_restore` oder kaputter Dump = Fehler + Push. | `dir`, `maxAgeHours`, `minBytes`           |
| `restore_probe`     | Wöchentlich: neuestes Backup mit `scripts/restore.sh --probe` in einen Wegwerf-Container (eigener Name, Port 5439) einspielen, Tabellen und `DEV_LOG_SECRET_KEY` prüfen, Container löschen. | `dir`, `timeoutSeconds` (Standard 300)     |
| `watchdog_logs`     | Wächter-Probleme (`collectProblems`); gleiche Probleme erst nach `REMIND_MS` (6 h) erneut.               | `project`                                  |
| `close_old_sprints` | Schliesst über `completeSprint` Sprints, die `sprintSettled` sind und `inactiveDays` inaktiv waren. Standardmässig **aus**. | `inactiveDays` (1–365)                     |
| `push_alert`        | Push an den Projektkreis über `sendPush`, wenn ein beobachteter Job fehlgeschlagen ist.                  | `project`, `jobs`                          |

## Admin-Endpunkt

- `GET /api/scheduled-jobs` liefert Jobs und die erlaubten Job-Arten.
- `PATCH /api/scheduled-jobs/:key` ändert `enabled`, `intervalSeconds` (60 s bis 30 Tage), `startAt` und `config` (JSON-Objekt, höchstens 4000 Zeichen). Bei neuem Intervall oder neuer Startzeit wird `next_run_at` ab dem letzten Lauf neu berechnet, frühestens ab der Startzeit.
- Beide Routen prüfen die Admin-Rolle serverseitig (Deklaration `access({ tenant: 'admin' })` an der Route und zusätzliche Prüfung in der Route, siehe `docs/agents-und-rechte.md`, Abschnitt „Benutzerrollen und Mandanten an den API-Routen“). Nicht-Administratoren erhalten 403.
- Die Job-Art lässt sich nicht ändern. Eine Oberfläche gibt es nicht.

## Worauf zu achten ist

- **Backup-Ordner:** Er ist nur im Backup-Container eingebunden. Ist er im Worker nicht sichtbar, meldet `backup_check` einen Fehler mit Push, statt still auszusetzen. Pfad bei Bedarf in `config.dir` setzen (muss im AIdeation-Ordner liegen).
- **pg_restore im Worker:** `backup_check` ruft `pg_restore --list` auf. Das Programm kommt aus `DEV_LOG_PG_RESTORE` in der `worker.env` oder aus dem PATH, nie aus der Datenbank. Es muss mindestens Version 17 haben, wie der Server. Fehlt es, meldet der Job „pg_restore --list nicht gefunden“ und schickt einen Push.
- **Restore-Probe:** Sie braucht `docker` im PATH des Workers, `node_modules` im AIdeation-Ordner und `DEV_LOG_SECRET_KEY` in der `worker.env`. Sie läuft nie gegen die Live-Datenbank oder Port 5433. Die E2E-Tests nutzen die Datenbank `dev_log_e2e`; die Probe läuft getrennt davon. Ein Fehlschlag steht mit der letzten Skriptzeile in der Meldung des Jobs.
- **Sprint-Abschluss** ändert den Status und ist darum standardmässig deaktiviert. Er schliesst nie einen Sprint mit offenen oder laufenden Aufträgen.
- **Standardjobs** legt `src/db/schema.ts` idempotent an (`CREATE TABLE IF NOT EXISTS`, `ON CONFLICT (key) DO NOTHING`). Änderungen der Administration bleiben bei einem Neustart erhalten.
- **Abgestürzter Worker:** Die Sperre `locked_until` läuft nach Zeitlimit + 30 s ab, danach ist der Job wieder beanspruchbar.
- `watchdog-cli.ts` und `deploy/backup.sh` sind unverändert. `BACKUP_FILE` ist in `watchdog.ts` jetzt exportiert und wird von beiden Stellen genutzt.

## Geänderte Dateien

- Neu: `src/runner/scheduler.ts`, `src/runner/scheduler.test.ts`, `src/api/scheduled-jobs.ts`, `src/api/scheduled-jobs.test.ts`
- Geändert: `src/db/schema.ts`, `src/api/app.ts`, `src/api/roles.ts`, `src/runner/runner-cli.ts`, `src/runner/watchdog.ts`, `docs/laufzeit.md`, `docs/erm.md`

## Tests und offene Punkte

- Typecheck und 56 Tests (`app`, `roles`, `scheduled-jobs`, `scheduler`, `watchdog`) bestanden.
- Die Abdeckung von `scheduler.ts` und `scheduled-jobs.ts` ist **nicht gemessen** (der Wächter blockiert `--experimental-test-coverage`).
- `npm run lint` meldet zwei bereits vorher vorhandene Fehler (`no-regex-spaces`) in `src/core/test-results.test.ts`, nicht in den Dateien dieses Auftrags.
- Ein eigener Test für die idempotente Schema-Anlage fehlt; geprüft nur durch Lesen des Codes.
- `purgeProductionData` (stündliche Aufbewahrung) wurde nicht in den Scheduler verlegt.
