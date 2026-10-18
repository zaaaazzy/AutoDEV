# Dev Log

Eigenständiges Projekt mit Angular-Oberfläche und TypeScript-/Express-API: Sprints, Ideen, Aufträge, Bugs, Dokumentation, Statistik und automatisch arbeitende Agents. Unabhängig von den Anwendungen, die es betreut (z. B. Mainty).

## Starten

1. Dienst + Datenbank: `docker compose up -d --build` → Oberfläche `http://localhost:3100` (Datenbank `127.0.0.1:5433`, eigenes Volume).
2. Worker (arbeitet alle Projekte automatisch ab, Autostart per launchd): `./scripts/install-worker.sh`. Log: `~/Library/Logs/dev-log-worker.log`. Ohne Autostart: `npm run worker`.
3. Lokales Modell: Ollama (`DEV_LOG_OLLAMA_MODEL`, Standard `qwen3.5:9b`). Optional pro Rolle: `DEV_LOG_OLLAMA_MODEL_<ROLLE>` (z. B. `_DEVELOPER`) und Kontext `DEV_LOG_OLLAMA_CTX[_<ROLLE>]` (Standard 16384, Entwickler 32768); `DEV_LOG_OLLAMA_KEEP_ALIVE` (Standard `30m`) hält das Modell geladen. Ollama-Einstellungen (Modell dauerhaft geladen, Flash Attention, KV-Cache q8_0, ein Modell gleichzeitig) setzt `./scripts/configure-ollama.sh` und startet die Ollama-App neu. Bei Verbindungsfehlern wird bis zu zweimal mit wachsender Wartezeit wiederholt.

## Entwicklung

- Node.js 22.12 oder neuer (Projektversion: `.nvmrc`, Docker: `22.22.3`).
- `npm run dev` startet die API auf Port 3100.
- `npm run dev:ui` startet die Angular-Entwicklungsoberfläche auf Port 4200 und leitet `/api` an die API weiter.
- `npm run build` baut die Angular-Oberfläche und kompiliert anschließend das Backend.
- `npm test` baut die Oberfläche und führt die Backend-Tests aus.
- `npm run lint`, `npm run format:check` und `npm run typecheck` prüfen Stil und Typen (läuft auch in der CI unter `.github/workflows`).

### Sicherheit

Login ist standardmäßig an (`DEV_LOG_USERNAME`, `DEV_LOG_PASSWORD` ≥ 16 Zeichen in `.env`). Der Container-Port ist standardmäßig nur an `127.0.0.1` gebunden (`DEV_LOG_BIND=0.0.0.0` in `.env` öffnet ihn für das lokale Netz; Basic Auth läuft dann unverschlüsselt über HTTP), der Container läuft als Nicht-Root. Die API setzt Security-Header (CSP), weist schreibende Cross-Origin-Anfragen ab und sperrt Clients nach 10 Fehlversuchen für 15 Minuten. Mit `DEV_LOG_AUTH=off` lauscht der Server nur auf `127.0.0.1` (`DEV_LOG_HOST` überschreibt das).

Wichtig: Wer sich anmelden kann, kann über Agent-, Test- und Deploy-Befehle beliebige Befehle auf dem Rechner des Workers ausführen. Für Zugriff von anderen Geräten daher nicht `DEV_LOG_BIND=0.0.0.0`, sondern einen HTTPS-Reverse-Proxy, Tailscale oder einen SSH-Tunnel verwenden; der Server warnt beim Start, wenn er im Netz erreichbar ist.

**Grenzen der Agent-Rechte:** Die Werkzeugregeln (Projektordner, gesperrte Dateien, erlaubte Befehle) schützen vor Fehlgriffen des Modells, sind aber keine Sandbox. Tests und npm-Skripte führen Code aus, den Agents geschrieben haben, und laufen mit den Rechten des Workers auf dem Host. Installationen laufen immer mit `--ignore-scripts`. Für die Projekt-Datenbank einen eigenen Benutzer ohne `DROP`-/Superuser-Rechte hinterlegen.

### Struktur

- `src/api/` Express-Routen, `src/core/` Hilfen (Validierung, Befehle, Sperren), `src/db/` Schema und Zugriff, `src/agent/` Ollama-Agent, Chat und Rollen, `src/runner/` Sprint-Runner, Worker, Tests und Git.
- `frontend/src/app/` Shell (`app.component`), `core/` (Store, API, Modelle), `shared/` (Pipes, Hilfen, kleine Komponenten), `features/<bereich>/` je ein Bereich der Oberfläche.

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
- Der Dashboard-Assistent übernimmt auch die Problemlösung: Er darf Fehler im Projektordner untersuchen und gezielt beheben; Dateien außerhalb des Projektordners, `.env`, Schlüssel, `node_modules` und `.git` bleiben gesperrt. Er darf Dienste per `docker compose` (ps, logs, up -d [--build], stop, start, restart, down, build) verwalten und Umgebungen aufsetzen (`git clone` per https/ssh in einen Unterordner des Projektordners, `git pull`, `npm install`); `down -v`, `docker run` und Pfade außerhalb des Projekts sind nicht erlaubt. Der Entwickler-Agent schreibt weiterhin mit Backups in `.dev-log-backups/`.
- Beim Abschluss eines Sprints: Bericht (umgesetzt / fehlt / Probleme) und Git-Sicherung (Commit `Sprint: <Name>`, Tag, Push).
- Eigene Agent-Befehle (z. B. `claude -p`) pro Agent oder global über `DEV_LOG_AGENT_COMMAND`; sonst der eingebaute Ollama-Agent.
- Manuelle Läufe: `npm run runner -- --project <slug> --cwd <Pfad>` bzw. `npm run test-agent -- --project <slug>`.

## Konfiguration

`DEV_LOG_DATABASE_URL`, `DEV_LOG_ADMIN_DATABASE_URL`, `DEV_LOG_AUTH` (`off` = kein Login, nur in vertrauenswürdigen Netzen), `DEV_LOG_PROJECT_ROOTS` (Doppelpunkt-getrennte Ordner, unter denen Projektordner liegen müssen), `DEV_LOG_USERNAME` / `DEV_LOG_PASSWORD`, `DEV_LOG_AGENT_COMMAND`, `DEV_LOG_MAX_TURNS`, `DEV_LOG_TEST_COMMANDS` (Fallback, JSON), `DEV_LOG_OLLAMA_URL`.

Datenmodell: [docs/erm.md](docs/erm.md).

## Git im Sprint

Jeder Sprint arbeitet auf einem eigenen Branch `sprint/<name>`. Nach jedem erfolgreich erledigten Sprint-Auftrag erstellt der Worker dort einen lokalen Commit (Conventional Commits, z. B. `feat(Sprint 1): Titel`, Bugs als `fix`); Änderungen fehlgeschlagener Aufträge werden geparkt statt mitcommittet. Die Sprint-Sicherung pusht nur bei grünen Projekttests; beim Abschluss wird nach `main` gemergt, erneut getestet, gepusht und getaggt. `.env`, `.dev-log/`, Agent-Sicherungen und Dateien, die nach Zugangsdaten aussehen, werden nie committet. Details: [Workflows](docs/workflows.md#6-git-im-sprint).

Dokumentation: [Agents und Rechte](docs/agents-und-rechte.md), [Workflows](docs/workflows.md).
