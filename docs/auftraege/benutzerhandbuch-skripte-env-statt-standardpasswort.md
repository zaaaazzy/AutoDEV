# Benutzerhandbuch: Skripte lesen die `.env` und fallen nicht mehr auf das Standardpasswort zurück

Gilt für Auftrag 3027e27e (Bugfix, Sprint 23). Betrifft Installation, Worker, Wächter, Testläufe und Wiederherstellung.

## Was sich ändert

Bisher hat der Einrichtungs-Assistent ein zufälliges Datenbank-Passwort gesetzt. Die Skripte fielen aber still auf das bekannte Passwort `devlog_local_dev` zurück, wenn die Variable in der Umgebung fehlte. Dadurch schrieb `install-watchdog.sh` in einer frischen Shell das alte Passwort in die Plist, und Worker und Wächter konnten sich nicht anmelden.

Jetzt gilt:

- **Ein Leser für die `.env`.** Alle Teile lesen die `.env` nach denselben Regeln wie der Einrichtungs-Assistent beim Schreiben. Das betrifft Worker, Wächter, Installationsskripte, Komplettlauf, E2E und Wiederherstellung.
- **Kein stiller Rückfall mehr.** Fehlt der Zugang, bricht das Skript mit einer Meldung ab. Es nimmt keinen Standardwert.
- **Worker und Wächter laden die `.env` selbst** beim Start, wenn ihre Env-Datei den Wert nicht enthält.

Eine Oberfläche gibt es dafür nicht. Die Änderung wirkt in der Befehlszeile und in den Hintergrunddiensten.

## Printscreens

Keine. Die Änderung betrifft nur Skripte und Meldungen. Der Bildschirm der Anwendung ist unverändert, deshalb gibt es nichts zu fotografieren. Die Meldungen stehen unten wörtlich, damit du sie im Terminal oder im Log wiedererkennst.

## Woher ein Wert kommt

Für `DEV_LOG_DATABASE_URL`, `DEV_LOG_SECRET_KEY` und die anderen Werte gilt diese Reihenfolge. Der erste gesetzte Wert gewinnt:

1. **Umgebung** der Shell (zum Beispiel `export DEV_LOG_DATABASE_URL=…`).
2. **`.env` der Installation** im Projektordner.
3. **Env-Datei des Dienstes** (`~/.config/aideation/worker.env` bzw. `watchdog.env`, unter Windows `worker.env`).

Die `.env` steht damit vor der Env-Datei des Dienstes. Führst du den Einrichtungs-Assistenten erneut aus und ändert sich das Passwort, übernimmt ein erneuter Dienst-Lauf das neue Passwort, ohne dass du etwas von Hand eintragen musst.

In einem Git-Worktree ohne eigene `.env` liest der Worker die `.env` des Hauptordners. Das gilt auch für Agent-Ordner.

## Was der Worker und der Wächter beim Start tun

Worker (`runner-cli`) und Wächter (`watchdog-cli`) übernehmen aus der `.env` nur diese Schlüssel:

- `DEV_LOG_DATABASE_URL`
- `DEV_LOG_REVIEW_DATABASE_URL`
- `DEV_LOG_SECRET_KEY`
- `DEV_LOG_PUBLIC_URL`
- `DEV_LOG_DOMAIN`
- `DEV_LOG_PROJECT_ROOTS`

Bewusst nicht übernommen wird `DEV_LOG_PASSWORD` (Anmeldung der Oberfläche). Agents würden es sonst erben.

**Bedingungen:**

- Fehlt die `.env`, ist das kein Fehler. Es zählen dann Umgebung und Env-Datei des Dienstes.
- Ist ein Wert schon gesetzt, bleibt er. Die Umgebung hat Vorrang.
- Fehlt `DEV_LOG_DATABASE_URL` überall, endet der Start mit einer Meldung (Details unten).

## Installation

Die Skripte `install-worker.sh`, `install-worker-linux.sh`, `install-watchdog.sh` und `install-worker.ps1` gehen so vor:

1. Sie lesen die Werte in der Reihenfolge oben.
2. Fehlt `DEV_LOG_DATABASE_URL` in allen drei Quellen, **brechen sie ab**. Es entsteht weder Env-Datei noch Plist, Unit oder Aufgabe.
3. Enthält die URL das Standardpasswort, brechen sie ebenfalls ab (siehe Ausnahme unten).

Frisch installierte Dienste übernehmen damit das Passwort aus der `.env`, auch aus einer neuen Shell ohne exportierte Variablen.

### Ausnahme: Standardpasswort ausdrücklich erlauben

Nur in einer Wegwerf-Umgebung, etwa für einen Test auf einem leeren Rechner:

```bash
DEV_LOG_ALLOW_DEFAULT_DB_PASSWORD=1 ./scripts/install-watchdog.sh
```

Dann erscheint nur eine Warnung, und die Installation läuft weiter. Im Normalbetrieb nicht setzen.

## Testläufe und E2E von Hand

`npm run test:full`, `npm run seed:demo` und die E2E-Tests lesen ohne vorgegebene Adresse `DEV_LOG_DB_USER` und `DEV_LOG_DB_PASSWORD` aus der `.env` (Port 5433).

- Fehlt dort `DEV_LOG_DB_PASSWORD`, brechen sie ab.
- Setzt du `DEV_LOG_DATABASE_URL` bzw. `E2E_ADMIN_DATABASE_URL` in der Umgebung, lesen sie die `.env` nicht. Die Adresse aus der Umgebung gilt.
- `DEV_LOG_ALLOW_DEFAULT_DB_PASSWORD=1` erlaubt auch hier das Standardpasswort, mit Warnung.

Der Worker gibt Testläufen nur `DEV_LOG_DATABASE_URL` und das daraus abgeleitete Admin-Ziel mit. Du musst dafür nichts einrichten.

## Wiederherstellung (`scripts/restore.sh`)

Die Wiederherstellung prüft, ob die Wiederherstellungs-Datenbank nicht die Live-Datenbank ist. Dafür liest sie die Live-Adresse wie die anderen Skripte.

- Fehlt die Live-Adresse, bricht der Schlüssel-Test mit einer Meldung ab. Die temporäre Datenbank wird entfernt. **Die Live-Datenbank bleibt unverändert.**

## Meldungen und Abhilfe

| Meldung (wörtlich, gekürzt) | Ursache | Abhilfe |
|---|---|---|
| `FEHLER: DEV_LOG_DATABASE_URL fehlt – weder in der Umgebung noch in der .env der Installation noch in der Env-Datei des Dienstes` | Keine der drei Quellen enthält die URL. Die `.env` fehlt, oder der Einrichtungs-Assistent hat sie noch nicht geschrieben. | `./start.sh --setup` ausführen, dann den Dienst erneut installieren. |
| `FEHLER: Die Datenbank-URL nutzt das öffentlich bekannte Standardpasswort „devlog_local_dev“` | Die URL enthält das Standardpasswort. | `./start.sh --setup` ausführen (setzt `DEV_LOG_DB_PASSWORD`), dann erneut installieren. |
| `DEV_LOG_DB_PASSWORD fehlt in der .env – ohne Passwort kein Zugang zur lokalen Datenbank` | `test:full`, `seed:demo` oder E2E lesen keine Adresse aus der Umgebung und keinen Passwort-Eintrag. | `./start.sh --setup` ausführen oder `DEV_LOG_DATABASE_URL` bzw. `E2E_ADMIN_DATABASE_URL` vorgeben. |
| `Wächter: DEV_LOG_DATABASE_URL fehlt – …` (Wächter-Log) | Der Wächter findet keine URL. Der Lauf endet mit Exit-Code 1. | Wie oben. Der Wächter startet alle zwei Minuten neu, bis die URL da ist. |
| Worker-Log: `DEV_LOG_DATABASE_URL fehlt – …` | Der Worker startet ohne URL und bricht ab, statt eine Dauerschleife zu drehen. | Wie oben, danach `npm run worker` oder den Dienst neu starten. |
| `WARNUNG: Die Datenbank-URL nutzt das Standardpasswort „devlog_local_dev“ (ausdrücklich erlaubt)` | `DEV_LOG_ALLOW_DEFAULT_DB_PASSWORD=1` ist gesetzt. | Nur in Wegwerf-Umgebungen. Sonst Variable entfernen und `./start.sh --setup` ausführen. |

## Prüfung nach der Umstellung

1. `.env` öffnen: `DEV_LOG_DB_PASSWORD` steht dort. Die Adresse in `DEV_LOG_DATABASE_URL` (falls gesetzt) enthält nicht das Standardpasswort `devlog_local_dev`.
2. Installation erneut ausführen. Ohne Fehlermeldung steht die Env-Datei des Dienstes in `~/.config/aideation/`.
3. Den Wächter einmal anstoßen. Sein Log darf keine Meldung „fehlt“ enthalten.
4. `npm run test:full` oder der Worker-Start aus einer **neuen** Shell ohne exportierte Variablen muss laufen.

## Grenzen

- **`docker-compose.yml`** setzt weiterhin `${DEV_LOG_DB_PASSWORD:-devlog_local_dev}` für die Container (Datenbank, Server, Hilfsdienste). Fehlt das Passwort in der `.env`, startet die Datenbank mit dem Standardpasswort. Der Server warnt dann. Dieser Auftrag hat die Compose-Datei nicht geändert.
- **PowerShell-Skript** `scripts/install-worker.ps1` ist in dieser Umgebung nicht ausgeführt worden (kein `pwsh`). Vor dem Einsatz unter Windows einmal selbst prüfen.
- **E2E-Läufe** sind mit dieser Änderung nicht ausgeführt worden. Die Unit- und Integrationstests laufen über `npm test`.
- **Review-Skript** (`deploy/review/aideation-review.sh`) bricht ohne `REVIEW_DATABASE_URL` ab. Es fällt nicht auf andere Zugänge zurück.
- **Passwörter mit Sonderzeichen** wie `@`, `:` oder `/` funktionieren. Die Adresse wird mit dem URL-Parser gebaut.
- Die `.env` wird nur gelesen, nicht verändert. Zum Ändern des Passworts gehört der Einrichtungs-Assistent (`./start.sh --setup`).

## Siehe auch

- `docs/installation.md`: Abschnitt „Woher die Skripte den Zugang nehmen“ und „Standardpasswort“.
- `docs/benutzerhandbuch-dashboard-agents.md`: Abschnitt zu Testläufen mit eigenem Datenbank-Passwort.
- `docs/skripte-lesen-env-statt-standardpasswort-2026-10-27.md`: Entwicklerdoku zur Umsetzung.
