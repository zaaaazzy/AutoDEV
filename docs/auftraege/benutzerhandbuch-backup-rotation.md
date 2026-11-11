# Benutzerhandbuch: Backup-Rotation

Gilt ab Sprint 23 (Auftrag dd56b42d). Betrifft den Dienst `backup` in `docker-compose.yml` und das Skript `deploy/backup.sh`.

## Was sich ändert

Bisher löschte das Skript alte Backups auch dann, wenn der Dump gescheitert war. Scheiterte `pg_dump` länger als 14 Tage, blieb danach kein einziges Backup übrig. Jetzt gilt:

- Alte Backups werden **nur nach einem erfolgreichen Dump** gelöscht.
- Die **neuesten 7 Backups bleiben immer**, auch wenn sie älter als die Aufbewahrungsfrist sind.
- Gelöscht werden **nur Dateien mit dem Muster `aideation-JJJJMMTT-HHMMSS.dump`**. Andere Dateien im Ordner `backups/` (fremde Präfixe, Handkopien) bleiben unberührt.
- Neue Dumps haben die Rechte **600** (nur der Besitzer kann sie lesen).

Eine Oberfläche gibt es für diese Änderung nicht. Sie zeigt sich nur im Ordner `backups/` und im Log des Backup-Containers. Deshalb gibt es hier keine Printscreens; die Meldungen aus dem Log stehen unten im Wortlaut.

## Bedingungen

Das Skript macht nur dann einen neuen Dump, wenn das letzte Backup älter als 23 Stunden ist. Es prüft das stündlich.

Die Rotation läuft nur, wenn alle drei Schritte geklappt haben:

1. `pg_dump` erstellt den Dump als temporäre Datei `.aideation-<Zeitstempel>.tmp`.
2. Die Datei wird in `aideation-<Zeitstempel>.dump` umbenannt.
3. Erst danach werden alte Backups geprüft.

Für die Auswahl gilt:

- Sortiert wird nach dem Zeitstempel im Dateinamen, nicht nach dem Änderungsdatum. Das Änderungsdatum ändert sich beim Kopieren oder Wiederherstellen.
- Die ersten `DEV_LOG_BACKUP_MIN_KEEP` Dateien (Standard **7**) bleiben immer erhalten.
- Von den übrigen wird eine Datei nur gelöscht, wenn sie älter als `DEV_LOG_BACKUP_KEEP_DAYS` Tage ist (Standard **14**).
- Fremde Dateien zählen nicht zur Mindestanzahl.

### Einstellungen in der `.env`

| Variable | Standard | Wirkung |
|---|---|---|
| `DEV_LOG_BACKUP_KEEP_DAYS` | 14 | Ab welchem Alter ein Backup gelöscht werden darf (Tage). |
| `DEV_LOG_BACKUP_MIN_KEEP` | 7 | Wie viele der neuesten Backups immer bleiben. |

Ungültige Werte, also Text, `0`, negative Zahlen oder ein leerer Wert, ergeben den Standard. Ein falscher Wert löscht also nie alles.

Nach einer Änderung der `.env` den Backup-Dienst neu starten: `docker compose up -d backup`.

## Was du siehst

Das Log des Containers zeigt, was passiert ist:

| Meldung im Log | Bedeutung |
|---|---|
| `Backup geschrieben: aideation-<Zeitstempel>.dump` | Dump erfolgreich, Rotation lief danach. |
| `Altes Backup gelöscht: <Dateiname>` | Ein Backup wurde nach der Regel entfernt. |
| `Backup fehlgeschlagen – keine Rotation` | `pg_dump` ist gescheitert. Es wurde nichts gelöscht. Der nächste Versuch folgt in einer Stunde. |
| `Backup konnte nicht umbenannt werden – keine Rotation` | Der Dump war da, das Umbenennen schlug fehl. Es wurde nichts gelöscht. |
| `Backup-Ordner nicht beschreibbar (Laufwerk getrennt?) – Neustart des Containers` | `./backups` ist nicht erreichbar. Der Container beendet sich und Docker startet ihn neu. |

Die Meldungen zu fehlgeschlagenen Dumps stehen im Fehlerkanal. Sie tauchen also in `docker compose logs backup` auf.

Der Healthcheck des Containers ist nur gesund, solange `./backups` beschreibbar ist und ein Backup jünger als 26 Stunden existiert. Der Wächter (`./scripts/install-watchdog.sh`) meldet ein zu altes Backup.

## Beispiel

Angenommen, der Dump scheitert zehn Tage lang, weil das Passwort geändert wurde. Dann bleiben alle Backups erhalten, auch die älteren als 14 Tage. Sobald der Dump wieder klappt, kommt das neue Backup dazu. Danach werden die ältesten Dateien über den 7 neuesten gelöscht, sofern sie älter als 14 Tage sind.

## Fehlerbehebung

| Problem | Ursache und Abhilfe |
|---|---|
| Log zeigt wiederholt „Backup fehlgeschlagen“ | Die Datenbank-Zugangsdaten oder der Speicherplatz stimmen nicht. Ursache im Log prüfen (`docker compose logs backup`). Bis dahin bleibt alles erhalten. |
| Ordner `backups/` wächst, obwohl alte Dateien da sind | Die Dateien sind jünger als `DEV_LOG_BACKUP_KEEP_DAYS` oder gehören zu den neuesten `DEV_LOG_BACKUP_MIN_KEEP`. Das ist gewollt. |
| Eigene Kopie wird nicht gelöscht | Gewollt: Nur `aideation-*.dump` wird rotiert. Umbenannte Dateien werden nicht mehr erfasst. |
| Ein Backup wird nie rotiert | Der Dateiname entspricht nicht dem Muster `aideation-JJJJMMTT-HHMMSS.dump`. Den Namen nicht ändern. |

## Wiederherstellen

Die Wiederherstellung läuft jetzt über das Skript `scripts/restore.sh` (siehe [Benutzerhandbuch: Restore-Skript und Restore-Probe](benutzerhandbuch-restore-skript-und-probe.md)):

```
bash scripts/restore.sh backups/<datei>.dump
```

Der frühere Befehl mit `pg_restore --clean` gegen die laufende Datenbank gilt nicht mehr.

## Noch offen

- **Temporäre Datei bei fehlgeschlagenem Umbenennen:** Schlägt das Umbenennen fehl, bleibt die Datei `.aideation-<Zeitstempel>.tmp` liegen und belegt Speicherplatz. Das Skript räumt sie bisher nur bei einem fehlgeschlagenen Dump auf. Die Meldung im Log zeigt, dass die Datei übrig ist.
- **Ungeprüft im Container:** Das Skript wurde bisher nicht in Docker ausgeführt. Ein Mensch sollte einmal `docker compose up backup` starten und prüfen, ob Dumps entstehen und die Rechte 600 haben.
- **Tests gegen das alte Skript:** Die Tests in `scripts/backup-rotation.test.ts` liefen nicht gegen die Vorfassung des Skripts.
