# Benutzerhandbuch: Restore-Skript und Restore-Probe

Gilt ab Sprint 23 (Auftrag 6f5cee71). Betrifft das Skript `scripts/restore.sh`, den Wartungs-Job `restore_probe` und die Prüfung `backup_check` im Wächter.

## Was sich ändert

Bisher stand im README ein Restore mit `pg_restore --clean` direkt gegen die laufende Datenbank. Dabei liefen API, Worker und Wächter weiter, und ein Fehler konnte eine halb wiederhergestellte Datenbank zurücklassen. Jetzt gibt es dafür ein Skript:

- **Ernstfall:** `bash scripts/restore.sh backups/<datei>.dump` ersetzt die Live-Datenbank. Vorher stoppt es die Dienste, spielt das Backup in eine **neue** Datenbank ein und prüft den Schlüssel. Erst dann wird umbenannt.
- **Probe:** `bash scripts/restore.sh --probe backups/<datei>.dump` spielt das Backup in einen **Wegwerf-Container** ein. Die Live-Datenbank bleibt unberührt.
- **Wöchentliche Probe:** Der Job `restore_probe` ruft die Probe automatisch mit dem neuesten Backup auf.
- **Prüfung im Wächter:** `backup_check` prüft das neueste Backup zusätzlich mit `pg_restore --list` und verlangt mindestens eine Tabelle mit Daten.

Den Aufruf mit `bash` schreibst du immer hin. Das Skript hat kein Ausführungsrecht; `bash scripts/restore.sh …` funktioniert trotzdem.

Eine Oberfläche gibt es für das Skript nicht. Es läuft im Terminal, der Job meldet sich im Wartungs-Bereich. Deshalb gibt es hier keine Printscreens. Die Ausgaben stehen unten im Wortlaut.

## Voraussetzungen

| Was | Wofür | Woran du es erkennst |
|---|---|---|
| `DEV_LOG_SECRET_KEY`, derselbe Wert wie beim Backup, in `.env` **und** `worker.env` | Entschlüsselungs-Test. Ohne ihn sind Projektzugänge und Zwei-Faktor-Schlüssel nach dem Restore nicht lesbar. | Warnung „WARNUNG: DEV_LOG_SECRET_KEY in .env und worker.env unterscheiden sich“ |
| Docker mit laufendem Dienst `db` | Ernstfall und Probe | „Datenbank-Dienst db läuft nicht – erst docker compose up -d db.“ |
| `node_modules` im AIdeation-Ordner (`npm ci`) | Schlüssel-Test | „Schlüssel-Test nicht möglich: node_modules fehlt …“ |
| `pg_restore` ab Version 17 auf dem Worker-Rechner, oder `DEV_LOG_PG_RESTORE` in `worker.env` | `backup_check` | „pg_restore --list nicht gefunden“ im Wächter |

Der Schlüssel wird nie ausgegeben. Das Skript zeigt bei Fehlern nur, dass etwas nicht passt, nicht den Wert.

## Ernstfall: Backup einspielen

Das Skript arbeitet in dieser Reihenfolge:

1. **Datei prüfen.** Ist die Datei fehlt, leer oder kein lesbares Backup, bricht es ab. Es stoppt dann nichts.
2. **Bestätigen.** Im Terminal fragt es nach:
   > Die Live-Datenbank „aideation“ wird durch aideation-….dump ersetzt. API, Oberfläche, Worker, Wächter und
   > Backup-Dienst werden dafür gestoppt. Die bisherige Datenbank bleibt als aideation_vor_restore_<zeit> erhalten.
   > Zum Fortfahren WIEDERHERSTELLEN eingeben:

   Nur das Wort `WIEDERHERSTELLEN` führt weiter. Alles andere bricht mit „Abgebrochen, nichts geändert.“ ab. Ohne Terminal (z. B. im Skript) geht es nur mit `--yes`.
3. **Dienste stoppen.** Worker und Wächter werden nur gestoppt, wenn sie installiert sind (launchd oder systemd). Danach stoppen `dev-log`, `frontend` und `backup`. Der Backup-Dienst sichert damit keinen halben Stand und rotiert nichts.
4. **Neue Datenbank füllen.** Das Backup geht in `aideation_restore_<zeit>`. Scheitert das Einspielen, wird diese neue Datenbank gelöscht. Die Live-Datenbank bleibt unverändert.
5. **Schlüssel-Test.** Alle verschlüsselten Werte der neuen Datenbank müssen mit `DEV_LOG_SECRET_KEY` lesbar sein. Scheitert er, wird die neue Datenbank gelöscht und nichts umbenannt.
6. **Umbenennen.** Erst jetzt wird `aideation` zu `aideation_vor_restore_<zeit>`, und die neue Datenbank heisst `aideation`. Verbindungen, die noch offen sind, trennt das Skript vorher.
7. **Dienste starten.** Das gilt auch dann, wenn ein früherer Schritt gescheitert ist.

Erfolgreich endet es mit:

```
Wiederhergestellt aus aideation-….dump. Bisherige Datenbank: aideation_vor_restore_<zeit>
Nach Prüfung entfernen: docker compose exec db dropdb -U devlog aideation_vor_restore_<zeit>
```

Die alte Datenbank bleibt liegen, bis du sie nach einer Prüfung mit dem angezeigten Befehl löschst. Das Skript löscht sie nicht selbst.

### Ist die Live-Datenbank nach einem Fehler noch unverändert?

Ja. Bis zum Umbenennen ändert das Skript nichts an der Live-Datenbank. Scheitert ein Schritt, steht es so in der Ausgabe:

- „Einspielen fehlgeschlagen (siehe oben) – Live-Datenbank unverändert, Dienste starten wieder.“
- „Schlüssel-Test fehlgeschlagen: Mit diesem DEV_LOG_SECRET_KEY wären die Projektzugänge nicht lesbar.“ Die Meldung sagt dazu, dass der Schlüssel aus der Zeit des Backups in `.env` und `worker.env` stehen muss.

Die Backups selbst werden nie gelöscht, verschoben oder rotiert.

## Probe: Backup prüfen, ohne etwas zu ändern

`bash scripts/restore.sh --probe backups/<datei>.dump` startet einen eigenen Container `aideation_restore_probe_<zeit>` (PostgreSQL 17, Daten nur im Arbeitsspeicher) auf `127.0.0.1:5439`. Er prüft:

- Die Tabellen `projects` und `development_items` sind vorhanden.
- Der Schlüssel passt.

Erfolgreich endet es mit:

```
Probe: Wegwerf-Container aideation_restore_probe_<zeit> auf 127.0.0.1:5439
Restore-Probe bestanden: aideation-….dump vollständig eingespielt (<n> Tabellen), Schlüssel passt.
```

Der Container wird am Ende gelöscht, auch wenn etwas gescheitert ist. Die Probe kann die Live-Datenbank nicht treffen: Sie lehnt die Namen `aideation`, `aideation_dev` und `dev_log_e2e…` ab, ebenso Port 5433 und den Port aus `DEV_LOG_DATABASE_URL`. Mit `RESTORE_PROBE_PORT` kannst du den Port ändern, nicht den Namen.

Läuft auf demselben Rechner ein anderer Container mit dem Label `aideation.restore-probe` (Rest einer abgebrochenen Probe), wird er vor dem Start entfernt.

## Wöchentlicher Job `restore_probe`

- Läuft einmal pro Woche und ist standardmässig an.
- Nimmt das neueste `aideation-*.dump` aus `./backups` und ruft darauf die Probe auf.
- Zeitlimit: 300 Sekunden (`timeoutSeconds`).
- **Erfolg:** Die letzte Zeile der Probe erscheint als Meldung des Jobs.
- **Fehlschlag:** Die letzte Fehlerzeile erscheint in der Meldung, dazu kommt eine Push-Benachrichtigung.
- **Kein Backup da:** Dann läuft keine Probe.

Der Job braucht Docker und `DEV_LOG_SECRET_KEY` in der `worker.env` auf dem Worker-Rechner.

## Prüfung `backup_check` im Wächter

Die Prüfung meldet jetzt auch dann einen Fehler, wenn das Backup nicht eingespielt werden kann:

| Meldung | Bedeutung | Abhilfe |
|---|---|---|
| „pg_restore --list nicht gefunden“ | Das Programm fehlt. Der Job meldet das bei jedem Lauf. | Postgres-Client ab 17 installieren (macOS: `brew install libpq`) oder `DEV_LOG_PG_RESTORE=/pfad/zu/pg_restore` in `worker.env` setzen. |
| Kaputter Dump (letzte Zeile von `pg_restore` steht in der Meldung) | Das Inhaltsverzeichnis lässt sich nicht lesen. | Backup neu erstellen und die Datei prüfen. |
| Dump ohne Daten | Im Inhaltsverzeichnis fehlen Tabellen mit Daten. | Ebenfalls neu sichern. |

Die Meldung steht im Wächter selbst und mit Push. Sie erscheint nicht nur im Log.

Die Standardzeit für die Prüfung ist jetzt 60 Sekunden statt 20.

## Beispiel

Du willst wissen, ob dein letztes Backup wirklich einspielbar ist:

1. `bash scripts/restore.sh --probe backups/aideation-20261026-030000.dump` (Dateiname als Beispiel).
2. Erscheint „Restore-Probe bestanden“, ist das Backup vollständig und der Schlüssel passt.
3. Erscheint eine Fehlerzeile, nichts an der Live-Datenbank ändern. Die Zeile nennt den Grund, meist Schlüssel oder fehlender Dienst.

Den Ernstfall probierst du zuerst auf einer Kopie der Installation aus, nie zuerst auf der Live-Installation.

## Fehlerbehebung

| Problem | Ursache und Abhilfe |
|---|---|
| „Backup-Datei … fehlt oder ist nicht lesbar“ | Pfad prüfen. Relative Pfade gelten ab dem Ordner, in dem du das Skript startest. |
| „ist kein lesbares Backup (pg_restore --list scheitert)“ | Die Datei ist beschädigt oder kein `pg_dump -Fc`-Backup. Ein anderes Backup nehmen. |
| „Abgebrochen, nichts geändert.“ | Du hast etwas anderes als `WIEDERHERSTELLEN` eingegeben. Den Befehl neu starten. |
| „Ohne Terminal nur mit --yes“ | Das Skript läuft ohne Eingabe. Ein Restore ohne Rückfrage geht nur mit `--yes`; das ist bewusst so. |
| „Port 5433 gehört der Live-Datenbank – Probe abgelehnt.“ | Mit `RESTORE_PROBE_PORT` einen freien Port wählen (nicht 5433). |
| „Wegwerf-Container ließ sich nicht starten (Port … belegt?)“ | Ein anderer Dienst belegt den Port. `RESTORE_PROBE_PORT` anders setzen. |
| „Dienste starten nicht – docker compose up -d“ | Nach dem Ernstfall fehlen Dienste. `docker compose up -d` ausführen. |
| „WARNUNG: DEV_LOG_SECRET_KEY in .env und worker.env unterscheiden sich“ | Beide Dateien auf denselben Wert bringen. Die Warnung zeigt die Werte nicht. |

## Wiederherstellen (Kurzfassung)

```
bash scripts/restore.sh backups/aideation-JJJJMMTT-HHMMSS.dump
```

Der alte Befehl mit `pg_restore --clean` gegen die laufende Datenbank ist nicht mehr der empfohlene Weg.

## Noch offen

- **Nicht im Echtbetrieb geprüft:** Die Probe und der Ernstfall sind mit echtem Docker noch nicht gelaufen. Die Beschreibung stammt aus dem Code und aus den Tests ohne Docker. Einmal `bash scripts/restore.sh --probe backups/<neuestes>.dump` von Hand ausführen.
- **Zeitlimit 300 Sekunden:** Bei grossen Datenbanken kann die wöchentliche Probe länger dauern. Das ist noch nicht geprüft.
- **`pg_restore` 17 auf dem Worker-Rechner:** Solange es fehlt oder `DEV_LOG_PG_RESTORE` nicht gesetzt ist, meldet `backup_check` bei jedem Lauf einen Fehler.
- **Alte Datenbank aufräumen:** `aideation_vor_restore_<zeit>` löschst du nach der Prüfung von Hand.
- **Ausführungsrecht:** `scripts/restore.sh` ist nicht ausführbar. Aufruf deshalb überall mit `bash`.
