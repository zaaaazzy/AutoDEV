# Dev Log

Eigenständiges Projekt mit Angular-Oberfläche und TypeScript-/Express-API: Sprints, Ideen, Aufträge, Bugs, Dokumentation, Statistik und automatisch arbeitende Agents. Unabhängig von den Anwendungen, die es betreut (z. B. Mainty).

## Starten

1. Dienst + Datenbank: `docker compose up -d --build` → Oberfläche `http://localhost:3101` (Datenbank `127.0.0.1:5433`, eigenes Volume).
2. Worker (arbeitet alle Projekte automatisch ab, Autostart per launchd): `./scripts/install-worker.sh`. Log: `~/Library/Logs/dev-log-worker.log`. Ohne Autostart: `npm run worker`.
3. Lokales Modell: Ollama (`DEV_LOG_OLLAMA_MODEL`, Standard `qwen3.5:9b`).

## Entwicklung

- Node.js 22.12 oder neuer (Projektversion: `.nvmrc`, Docker: `22.22.3`).
- `npm run dev` startet die API auf Port 3100.
- `npm run dev:ui` startet die Angular-Entwicklungsoberfläche auf Port 4200 und leitet `/api` an die API weiter.
- `npm run build` baut die Angular-Oberfläche und kompiliert anschließend das Backend.
- `npm test` baut die Oberfläche und führt die Backend-Tests aus.

## Projekt anlegen

In der Oberfläche ein Projekt anlegen und unter **Projekteinstellungen** angeben:

- **Projektordner**: absoluter Pfad. Dort lesen und schreiben die Agents, dort laufen die Tests und der Git-Sync.
- **Testbefehle** (optional): ein Befehl pro Zeile, Standard `npm run build` + `npm test`.
- **GitHub-Repository** (optional): `git@github.com:user/repo.git`, Zugang über SSH-Key, nie Zugangsdaten in der URL.

Der Worker bedient jedes registrierte Projekt in dessen Ordner. Fehlt der Ordner, zeigt das Worker-Badge den Fehler.

## Ablauf

- Neue **Ideen** formuliert der Auftragsautor automatisch zu Aufträgen im Backlog aus; per „Erneut anfragen“ mit Änderungswunsch überarbeitbar.
- **Sprints** werden manuell zugewiesen und gestartet. Nur Aufträge aktiver Sprints werden bearbeitet.
- **Workflow** je Auftrag: Pre-Task → While-Task → After-Task (Bug-Wächter, Entwickler, Tester, Dokumentierer, Handbuch-Autor). Erfolg → `done`, Fehlschlag → `blocked` plus automatischer Bug.
- Nur der Entwickler darf Dateien schreiben (Backups in `.dev-log-backups/` im Projektordner) und nur `npm test|run`, `git status|diff|log` ausführen.
- Beim Abschluss eines Sprints: Bericht (umgesetzt / fehlt / Probleme) und Git-Sicherung (Commit `Sprint: <Name>`, Tag, Push).
- Eigene Agent-Befehle (z. B. `claude -p`) pro Agent oder global über `DEV_LOG_AGENT_COMMAND`; sonst der eingebaute Ollama-Agent.
- Manuelle Läufe: `npm run runner -- --project <slug> --cwd <Pfad>` bzw. `npm run test-agent -- --project <slug>`.

## Konfiguration

`DEV_LOG_DATABASE_URL`, `DEV_LOG_ADMIN_DATABASE_URL`, `DEV_LOG_AUTH` (`off` = kein Login), `DEV_LOG_USERNAME` / `DEV_LOG_PASSWORD`, `DEV_LOG_AGENT_COMMAND`, `DEV_LOG_MAX_TURNS`, `DEV_LOG_TEST_COMMANDS` (Fallback, JSON), `DEV_LOG_OLLAMA_URL`.

Datenmodell: [docs/erm.md](docs/erm.md).
