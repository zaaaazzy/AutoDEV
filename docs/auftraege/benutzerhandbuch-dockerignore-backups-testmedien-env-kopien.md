# Benutzerhandbuch: Docker-Build ohne Backups, Testmedien und .env-Kopien

Stand: 2026-10-27 · Auftrag `98bc3c28` · Sprint 23

## Was sich für dich ändert

Der Docker-Build schickt keine Sicherungen, Testmedien und Schlüsselkopien mehr an den Docker-Daemon. Dadurch werden
`docker compose up --build` und der automatische Neustart durch AIdeation schneller, und das API-Image wird kleiner.
Vor allem landen Screenshots mit App-Daten und Datenbank-Dumps nicht mehr dauerhaft in einer Image-Schicht.

Im Alltag ändert sich nichts: Die Oberfläche, die Bedienung und die Konfiguration bleiben gleich. Du musst nichts
umstellen.

**Printscreens: keine.** Die Änderung betrifft nur die Datei `.dockerignore` und den Build. Die Oberfläche bleibt
gleich.

## Was nicht mehr ins Image gelangt

Die Datei `.dockerignore` im Projektordner legt fest, welche Pfade der Build überspringt:

| Pfad | Inhalt | Warum ausgeschlossen |
|---|---|---|
| `backups/` | Datenbank-Dumps (über 200 MB) | Enthält alle Daten der Datenbank |
| `.dev-log-backups` | Merge-Abbruch-Patches des Runners | Können Projektcode samt Zugangsdaten enthalten |
| `docs/tests` | Testmedien (Screenshots, Videos) | Enthalten App-Daten und sind nur für Tests da |
| `test-results`, `playwright-report` | Testergebnisse und Berichte | Nur Ausgaben von Tests |
| `e2e` | Playwright-Tests | Kein Dockerfile kopiert sie |
| `.env`, `.env.*` | Zugangsdaten und Kopien davon (z. B. `.env.bak-…`) | Schlüssel gehören nie in ein Image |
| `**/*.pem`, `**/*.key` | Zertifikate und Schlüssel | Schlüssel gehören nie in ein Image |
| `.dev-log` | Laufzeitdaten und Logs | Wechselnder Zustand, kein Teil des Programms |
| `node_modules`, `dist`, `.angular`, `.git`, `out-tsc` | Abhängigkeiten, Build-Reste, Git | Werden im Build neu erzeugt oder sind unnötig |

## Was weiter im Image bleibt

Das Dockerfile kopiert aus `docs/` nur drei Dateien. Die Workflow-Seiten der Dokumentation lesen genau diese Dateien
zur Laufzeit:

- `docs/laufzeit.md` (Ablauf zur Laufzeit)
- `docs/workflows.md` (Workflows)
- `docs/agents-und-rechte.md` (Agents und Rechte)

Der Rest von `docs/` bleibt draussen. Die Handbücher und Auftragsdokus liegen auf dem Rechner, nicht im Image.

## Bedingungen

- **Die `.env` gehört auf den Rechner, nicht ins Image.** Compose liest sie für die Werte in der Konfiguration und reicht
  die nötigen Variablen als `environment:` an den Dienst weiter (z. B. `DEV_LOG_SECRET_KEY`, `DEV_LOG_DB_PASSWORD`). Das
  bleibt unverändert, weil die Datei nur für die Werte beim Start gebraucht wird.
- **Neue Dateien aus `docs/`, die zur Laufzeit gelesen werden, müssen ins Dockerfile.** Sonst fehlen sie im Image, und die
  Seite zeigt nichts an. Dafür ergänzt man eine Zeile `COPY` im Dockerfile und trägt die Datei in `WORKFLOW_DOCS`
  (`src/api/workflow-docs.ts`) ein.
- **Der Build-Kontext bleibt `.`.** Die Oberfläche (`deploy/frontend`) nutzt denselben Ausschluss. Sie kopiert nur
  `frontend/`, `src/core/` und `deploy/frontend/`, deshalb ändert sich dort nichts.
- **Das Muster `e2e` ist breit.** Kopiert ein Dockerfile künftig etwas aus `e2e/`, muss die Regel angepasst werden.
- **Eigene Sicherungen liegen nicht im Build.** Die `backups/`-Ordner bleiben auf dem Rechner. Sie sind weiterhin wie die
  Datenbank selbst zu behandeln.

## Einmalige Prüfung nach dem Umstellen

1. Den Build mit `docker compose build dev-log` starten. Er muss ohne Fehler durchlaufen.
2. Prüfen, dass im API-Image keine Sicherungen oder Testmedien liegen. Dazu die Dateien im Container auflisten, ohne
   `.env` zu öffnen. Erwartet wird, dass `/app/docs` nur die drei Workflow-Dateien enthält.
3. Die Workflow-Seiten der Dokumentation öffnen. Sie müssen die drei Seiten anzeigen.

## Fehlermeldungen und Behebung

| Symptom | Ursache | Behebung |
|---|---|---|
| Eine Workflow-Seite ist leer oder fehlt | Die Datei fehlt im Image | Im Dockerfile eine `COPY`-Zeile für die Datei ergänzen, dann neu bauen |
| `COPY` im Build schlägt fehl (Datei nicht gefunden) | Die Datei steht in `.dockerignore` | Den Eintrag in `.dockerignore` prüfen; die Datei nicht über das Dockerfile holen, die Regel anpassen |
| Build ist trotzdem gross | Ein Pfad fehlt in `.dockerignore` | Den Pfad ergänzen und die Testdatei `src/core/docker-build.test.ts` um den Pfad erweitern |

## Noch offen

- Ein `docker compose build` mit dem neuen Build-Kontext ist in dieser Sitzung nicht gelaufen. Build-Zeit und
  Image-Grösse sind deshalb nicht gemessen. Das soll ein Mensch einmal prüfen.
- Die Testdatei `src/core/docker-build.test.ts` lief nur im Rahmen der gesamten Testsuite (1601 Tests grün), nicht einzeln
  und nicht gegen die alte `.dockerignore`.
