# AIdeation

Eigenständiges Projekt mit Angular-Oberfläche und TypeScript-/Express-API: Sprints, Ideen, Aufträge, Bugs, Dokumentation, Statistik und automatisch arbeitende Agents. Unabhängig von den Anwendungen, die es betreut (z. B. Mainty).

## Schnellstart

```bash
git clone <repository-url> AIdeation/source && cd AIdeation/source
./start.sh          # Windows: start.cmd
```

Beim ersten Start führt ein Einrichtungs-Assistent im Browser durch Docker, Zugang und Worker; danach begrüßt dich
AIdeation mit dem Projekt-Assistenten und einer interaktiven Tour. Ausführlich: [Installation](docs/installation.md).

## Starten (manuell)

1. Dienst + Datenbank: `docker compose up -d --build` → Oberfläche lokal `http://localhost:3100`, von aussen optional `https://<DEV_LOG_DOMAIN>` (siehe Sicherheit). Datenbank `127.0.0.1:5433`, eigenes Volume.
2. Worker (arbeitet alle Projekte automatisch ab, Autostart per launchd): `./scripts/install-worker.sh`. Log: `~/Library/Logs/aideation-worker.log`. Ohne Autostart: `npm run worker`.
3. Lokales Modell: Ollama (`DEV_LOG_OLLAMA_MODEL`, Standard `qwen3.5:9b`). Optional pro Rolle: `DEV_LOG_OLLAMA_MODEL_<ROLLE>` (z. B. `_DEVELOPER`) und Kontext `DEV_LOG_OLLAMA_CTX[_<ROLLE>]` (Standard 16384, Entwickler 32768); `DEV_LOG_OLLAMA_KEEP_ALIVE` (Standard `30m`) hält das Modell geladen. Ollama-Einstellungen (Modell dauerhaft geladen, Flash Attention, KV-Cache q8_0, ein Modell gleichzeitig) setzt `./scripts/configure-ollama.sh` und startet die Ollama-App neu. Bei Verbindungsfehlern wird bis zu zweimal mit wachsender Wartezeit wiederholt.

## Entwicklung

- Node.js 22.12 oder neuer (Projektversion: `.nvmrc`, Docker: `22.22.3`).
- `npm run dev` startet die API auf Port 3100.
- `npm run dev:ui` startet die Angular-Entwicklungsoberfläche auf Port 4200 und leitet `/api` an die API weiter.
- `npm run build` baut die Angular-Oberfläche und kompiliert anschließend das Backend.
- `npm test` baut die Oberfläche und führt die Backend-Tests aus.
- `npm run lint`, `npm run format:check` und `npm run typecheck` prüfen Stil und Typen. `typecheck` prüft auch die Test-Dateien (`tsconfig.test.json`, `frontend/tsconfig.spec.json`), denn `tsx` allein prüft keine Typen.
- `npm run test:e2e` startet die Oberflächentests (Playwright, eigene Datenbank `dev_log_e2e`; vorher `npm run build:ui`).
- CI (`.github/workflows/ci.yml`, nur Leserechte): Job `check` (Lint, Format, Typen, Tests), Job `e2e` (Playwright gegen Postgres), Job `docker` (`docker compose build`, danach Start mit Health-Prüfung von `db`, `dev-log` und `frontend`). `.dockerignore` hält `.env*`, Schlüssel, Sicherungen und Testergebnisse aus den Images heraus.

### Sicherheit

Login ist standardmäßig an (`DEV_LOG_USERNAME`, `DEV_LOG_PASSWORD` ≥ 16 Zeichen in `.env`). Die Oberfläche (`aideation_frontend_angular`, nginx) ist nur an `127.0.0.1:3100` gebunden und leitet `/api` an das Backend (`aideation_backend_nodejs`, Nicht-Root, ohne eigenen Port nach aussen) weiter. Von aussen geht der Zugriff ausschließlich über HTTPS: Der Dienst `https` (Caddy, `deploy/Caddyfile`) lauscht auf 80/443, holt das Zertifikat für `DEV_LOG_DOMAIN` automatisch bei Let's Encrypt und leitet an die Oberfläche weiter (Router: Port 443 auf diesen Rechner weiterleiten). AIdeation übernimmt Protokoll und Client-IP vom Proxy (`DEV_LOG_TRUST_PROXY`). API und Oberfläche setzen dieselben Security-Header (CSP; nginx: `deploy/frontend/security-headers.conf`), weist schreibende Cross-Origin-Anfragen ab und sperrt Clients nach 10 Fehlversuchen für 15 Minuten. Ohne Container (`npm start`, `npm run dev`) lauscht der Server nur auf `127.0.0.1`; `DEV_LOG_HOST` überschreibt das (im Container `0.0.0.0`). API-Pfade unterscheiden Groß-/Kleinschreibung, Anmeldung, Rollen und Mandantenprüfung hängen am Router unter `/api`.

Anmeldung über die Login-Seite (Sitzungs-Cookie, 30 Tage). Unter Einstellungen → Sicherheit lässt sich die Zwei-Faktor-Anmeldung mit einer Authenticator-App einrichten; danach gilt Basic Auth (für Skripte) nicht mehr. Code verloren: `docker compose exec db psql -U devlog aideation -c "DELETE FROM app_settings WHERE key = 'auth_totp_secret'"` und `docker compose restart dev-log`.

### Betrieb

- **App & Push:** AIdeation ist als App installierbar (Manifest, Service Worker). Unter Einstellungen → App & Benachrichtigungen pro Gerät Push einschalten (iPhone: erst „Zum Home-Bildschirm“). Meldungen: Auftrag erledigt/blockiert, Antwort/Rückfrage des Assistenten, Ausfall.
- **Backups:** Dienst `backup` schreibt täglich `backups/aideation-*.dump` (14 Tage, `DEV_LOG_BACKUP_KEEP_DAYS`). Wiederherstellen: `docker compose exec -T db pg_restore -U devlog -d aideation --clean < backups/<datei>.dump`.
- **Wächter:** `./scripts/install-watchdog.sh` prüft alle zwei Minuten Dienst, HTTPS, Datenbank, Worker, Backup-Alter und Speicherplatz und meldet Probleme per Push (Log: `~/Library/Logs/aideation-watchdog.log`). Fällt der ganze Rechner oder die Internetleitung aus, kann er nichts melden – dafür einen externen Monitor auf `https://<DEV_LOG_DOMAIN>/health` setzen.
- **Produktions-Rückkanal:** Unter Einstellungen → Betrieb je Projekt Health-URL (nur http(s) auf localhost, LAN oder eigener Domain: `DEV_LOG_DOMAIN`, `DEV_LOG_OWN_DOMAINS`), Compose-Dienste für den Log-Scan, Ausschlussmuster, Aufbewahrung (Standard 30 Tage) und das Ingest-Token (nur der Hash wird gespeichert). Der Worker prüft die Health-URL alle 2 Minuten (zwei Fehlschläge in Folge = kritischer Bug „Anwendung nicht erreichbar“ und Push, Erholung = Entwarnung) und liest alle 15 Minuten sowie nach jedem Deploy `docker compose logs --since 15m --no-color`. Die Anwendung kann Fehler selbst an `POST /api/ingest/<projekt>/<token>` melden (ohne Login, 16 KB, Rate-Limit). Gleiche Fehler werden über einen Fingerabdruck gebündelt, maskiert und erst ab drei Vorkommen innerhalb von 24 Stunden als Bug mit Quelle „Betrieb“ erfasst (Ausfälle wie ein Health-Ausfall sofort); ein behobener Bug wird bei erneutem Auftreten als Regression geöffnet. Snippets für Browser und Node: Dokumentation → „Betrieb: Fehler an AIdeation melden“.
- **Oberflächentests:** `npm run test:e2e` (Playwright, Desktop und Handy) startet AIdeation auf einer eigenen Datenbank `dev_log_e2e`; einmalig `npx playwright install chromium`.

Wichtig: Wer sich anmelden kann, kann über Agent-, Test- und Deploy-Befehle beliebige Befehle auf dem Rechner des Workers ausführen. Deshalb ein starkes Passwort verwenden und AIdeation nie per HTTP ins Netz stellen.

**Grenzen der Agent-Rechte:** Die Werkzeugregeln (Projektordner, gesperrte Dateien, erlaubte Befehle) schützen vor Fehlgriffen des Modells, sind aber keine Sandbox. Tests und npm-Skripte führen Code aus, den Agents geschrieben haben, und laufen mit den Rechten des Workers auf dem Host. Installationen laufen immer mit `--ignore-scripts`. Für die Projekt-Datenbank einen eigenen Benutzer ohne `DROP`-/Superuser-Rechte hinterlegen.

### Struktur

- `src/api/` Express-Routen, `src/core/` Hilfen (Validierung, Befehle, Sperren), `src/db/` Schema und Zugriff, `src/agent/` Ollama-Agent, Chat und Rollen, `src/runner/` Sprint-Runner, Worker, Tests und Git.
- `frontend/src/app/` Shell (`app.component`), `core/` (Store, API, Modelle), `shared/` (Pipes, Hilfen, kleine Komponenten), `features/<bereich>/` je ein Bereich der Oberfläche.

## Projekt anlegen

In der Oberfläche ein Projekt anlegen und unter **Projekteinstellungen** angeben:

- **Projektordner**: absoluter Pfad. Dort lesen und schreiben die Agents, dort laufen die Tests und der Git-Sync.
- **Testbefehle** (optional): ein Befehl pro Zeile, Standard `npm run build` + `npm test`.
- **GitHub-Repository** (optional): `git@github.com:user/repo.git`, Zugang über SSH-Key, nie Zugangsdaten in der URL.
- **GitHub-Brücke** (optional, Standard aus): Issues mit Label `idea`/`bug` übernehmen und Status zurückmelden, wahlweise Sprint-Abschluss als Pull Request mit CI-Ampel. Braucht `gh auth login` des Worker-Benutzers, kein Token in Dev Log (siehe `docs/workflows.md`).

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

`DEV_LOG_DATABASE_URL`, `DEV_LOG_ADMIN_DATABASE_URL`, `DEV_LOG_TIMEZONE` (IANA-Zeitzone für Tagesgrenzen von Budget-Tag und Burndown, Standard `Europe/Zurich`; die Datenbank bleibt in UTC), `DEV_LOG_AUTH` (`off` = kein Login, nur in vertrauenswürdigen Netzen), `DEV_LOG_PROJECT_ROOTS` (Doppelpunkt-getrennte Ordner, unter denen Projektordner liegen müssen), `DEV_LOG_USERNAME` / `DEV_LOG_PASSWORD`, `DEV_LOG_AGENT_COMMAND`, `DEV_LOG_MAX_TURNS`, `DEV_LOG_TEST_COMMANDS` (Fallback, JSON), `DEV_LOG_OLLAMA_URL`, `DEV_LOG_SECRET_KEY` (≥ 16 Zeichen: verschlüsselt die Datenbank-Zugänge der Projekte mit AES-256-GCM, damit sie auch in Backups nicht im Klartext stehen; beim Start werden bestehende Klartext-Zugänge umgestellt. Derselbe Wert muss in `.env` für den Container und beim Installieren des Workers gesetzt sein, z. B. `DEV_LOG_SECRET_KEY=… ./scripts/install-worker.sh`; geht er verloren, müssen die Zugänge neu eingetragen werden).

Datenmodell: [docs/erm.md](docs/erm.md).

## Git im Sprint

Jeder Sprint arbeitet auf einem eigenen Branch `sprint/<name>`. Nach jedem erfolgreich erledigten Sprint-Auftrag erstellt der Worker dort einen lokalen Commit (Conventional Commits, z. B. `feat(Sprint 1): Titel`, Bugs als `fix`); Änderungen fehlgeschlagener Aufträge werden geparkt statt mitcommittet. Die Sprint-Sicherung pusht nur bei grünen Projekttests; beim Abschluss wird nach `main` gemergt, erneut getestet, gepusht und getaggt. `.env`, `.dev-log/`, Agent-Sicherungen und Dateien, die nach Zugangsdaten aussehen, werden nie committet. Details: [Workflows](docs/workflows.md#6-git-im-sprint).

Dokumentation: [Agents und Rechte](docs/agents-und-rechte.md), [Agent-Tests](docs/agent-tests.md), [Workflows](docs/workflows.md).

Im Dashboard zeigt Dokumentation → Marketing → „Agents, Aufgaben und Rechte“ (`#docs/marketing/agent-permissions`, nur mit dem Recht „Dokumentation bearbeiten“) die Rollen aus `agents.role` mit Phase, Aufgabe, Datei- und Befehlsrechten, den Ablauf als Diagramm und die Sicherheitsgrenzen. Die Inhalte stehen statisch in `frontend/src/app/features/docs/marketing/agent-permissions.ts` und stammen aus [Agents und Rechte](docs/agents-und-rechte.md), Abschnitt 3. Ändert sich dort die Tabelle „Workflow-Agents“, schlägt `npm test` fehl, bis die Seite nachgezogen ist.
