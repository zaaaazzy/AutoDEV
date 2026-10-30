# Backup-Rotation nur nach erfolgreichem Dump, Mindestanzahl behalten

Auftrag dd56b42d (Bugfix, Sprint 23). Aus dem Code-Review vom 21.10.2026 (Stand `a4971e9`).

## Problem

In `deploy/backup.sh` lief `find … -mtime +14 -delete` auch dann, wenn `pg_dump` gescheitert war. Es behielt keine Mindestanzahl und traf jedes `*.dump`, auch fremde Präfixe. Scheiterte der Dump länger als 14 Tage (Passwort per `ALTER USER` geändert, Laufwerk voll), blieb kein einziges Backup übrig.

## Umsetzung

- **Rotation nur nach Erfolg** (`deploy/backup.sh`): `rotate` läuft erst, wenn `pg_dump` und das Umbenennen der Temp-Datei geklappt haben. Bei einem Fehler wird die Temp-Datei entfernt, nichts gelöscht und „keine Rotation“ gemeldet.
- **Mindestanzahl**: Die neuesten `BACKUP_MIN_KEEP` (Standard 7) Dateien `aideation-<Datum>-<Zeit>.dump` bleiben immer. Sortiert wird nach dem Zeitstempel im Namen, nicht nach `mtime` (das ändert sich beim Kopieren oder Wiederherstellen).
- **Alter**: Von den übrigen wird nur gelöscht, was älter als `BACKUP_KEEP_DAYS` (Standard 14) Tage ist.
- **Nur eigene Dateien**: Der Filter ist `^aideation-[0-9]{8}-[0-9]{6}\.dump$`. Fremde Präfixe und Handkopien bleiben unberührt.
- **Eingaben**: `number()` akzeptiert nur positive ganze Zahlen; ungültige Werte (leer, Text, 0) ergeben den Standard, nie „alles löschen“.
- **Dateirechte**: `umask 077`, Dumps sind `600`.
- **Testbarkeit**: `BACKUP_DIR` (statt `/backups`) und `BACKUP_ONCE=1` (ein Durchlauf).
- **Konfiguration**: `docker-compose.yml` reicht `DEV_LOG_BACKUP_MIN_KEEP` (Standard 7) als `BACKUP_MIN_KEEP` durch.
- **Doku**: Absatz in `docs/installation.md`, Backup-Zeile in `README.md`, Kopfkommentar im Skript.

## Tests

`scripts/backup-rotation.test.ts` führt das echte Skript mit einem Ersatz-`pg_dump` in einem temporären Ordner aus (läuft bei `npm test` mit, braucht `/bin/sh`, `find`, `ls`, `sort`, `tail`, weder Docker noch Datenbank):

- Gescheiterter Dump löscht nichts und hinterlässt keine Temp-Datei.
- Erfolgreicher Dump: neues Backup plus die 6 neuesten alten bleiben, die 4 ältesten werden gelöscht, Fremddateien bleiben, Dump hat Rechte 600.
- Backups jünger als `BACKUP_KEEP_DAYS` bleiben auch über die Mindestanzahl hinaus.
- Ungültiges `BACKUP_MIN_KEEP` ergibt 7; `BACKUP_MIN_KEEP=3` wird beachtet.

Nicht belegt: Der Test wurde nicht gegen das alte Skript ausgeführt (der Wächter erlaubt nur die ganze Suite); nach Code-Lage wäre er dort rot gewesen.

## Geänderte Dateien

- `deploy/backup.sh`, `docker-compose.yml`
- `scripts/backup-rotation.test.ts`
- `docs/installation.md`, `README.md`

## Worauf zu achten ist

- Neue optionale Variable `DEV_LOG_BACKUP_MIN_KEEP` (Standard 7) in der `.env`.
- Scheitert der Dump dauerhaft, wächst der Ordner nicht, es kommen aber auch keine neuen Backups. Die Fehlermeldung „Backup fehlgeschlagen – keine Rotation“ steht im Container-Log; der Wächter `backup_check` meldet ein zu altes Backup.
- Die Dateinamen müssen dem Muster `aideation-JJJJMMTT-HHMMSS.dump` entsprechen, sonst werden sie nie rotiert.
- Das Skript ist nicht mit Docker gestartet worden; ein Mensch sollte `docker compose up backup` einmal prüfen.
