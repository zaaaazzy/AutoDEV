# Docker-Sandbox Phase 4 (optional): Worker als Compose-Dienst

## Aufträge

### Auftrag 8566b14a

Phase 4 von 4 (optional) des Konzepts „Agents plattformunabhängig in Docker-Sandbox ausführen“ (Sammelauftrag 36217529). Sprint „Isolation“, Branch `auftrag/8566b14a-docker-sandbox-phase-4-optional-`, Commit b303949 (Agent „Entwickler“). Setzt Phase 3 voraus.

**Ergebnis:** Der Worker läuft optional als Dienst in `docker-compose.yml` (Profil `worker`). Die Installation besteht dann auf macOS, Linux und Windows aus Docker und `./start.sh` bzw. `start.cmd`. launchd, systemd und `scripts\run-with-env.ps1` werden für den Worker nicht gebraucht. Der Einrichtungs-Assistent bietet „Worker im Container“ als Standard an. Das Profil `worker` muss in `COMPOSE_PROFILES` der `.env` stehen (der Assistent setzt es), sonst startet der Worker nicht.

**Anforderung → Umsetzung**

- Dienste (`docker-compose.yml`, Image `aideation-worker` aus `deploy/worker/Dockerfile`):
  - `worker`: Node 22, Git, SSH, `gh`, Docker-CLI mit Compose und Buildx. Der Code kommt aus dem eingebundenen AIdeation-Ordner, nicht aus dem Image. Start über `deploy/worker/entrypoint.sh` (`runner-cli.ts --all --watch --limit 3`). `node_modules` liegen im Volume `aideation_worker_modules` (Linux-Binärdateien); der Entrypoint führt `npm ci --ignore-scripts` aus, wenn sie fehlen oder das Lockfile neuer ist.
  - `worker-volumes`: einmaliger Schritt (`chown` auf `/modules`, kein Netzwerk, `read_only`), damit der Worker-Benutzer das Volume beschreiben darf.
  - `watchdog`: Ausfall-Wächter als eigener Dienst (`watchdog-cli.ts` alle `DEV_LOG_WATCHDOG_INTERVAL` Sekunden, Standard 120). Push-Meldungen bleiben gleich. Ohne Docker-Socket und ohne Git-Zugang, Ordner nur lesend, `read_only`, Zustand im Volume `aideation_watchdog_state`.
- **Docker-Socket nur im `worker`:** Nur dieser Dienst bindet `/var/run/docker.sock` ein. Zugriff ohne root über `user` (`DEV_LOG_WORKER_USER`, Linux `uid:gid`) und `group_add` (`DEV_LOG_DOCKER_GID`, Standard 0 für Docker Desktop). `cap_drop: ALL`, `no-new-privileges`, Ressourcengrenzen.
- **Gleiche Pfade wie auf dem Host:** `docker-compose.override.yml` (erzeugt von `src/setup/worker-compose.ts` über `scripts/worker-compose.ts`, aufgerufen von `start.sh`, `scripts/start.ps1` und dem Assistenten) bindet den AIdeation-Ordner und alle Ordner aus `DEV_LOG_PROJECT_ROOTS` mit identischem Pfad ein. Unter Windows gilt der Docker-Desktop-Pfad (`C:\Users\a` → `/c/Users/a`, `workerContainerPath`, `dockerHostPath`). Ohne `DEV_LOG_PROJECT_ROOTS` gilt der Ordner, in dem AIdeation liegt. Doppelte und verschachtelte Ordner werden entfernt. `workerPath` in `src/core/worker-container.ts` rechnet in der Oberfläche eingetragene Windows-Pfade im Worker auf `/c/…` um.
- **Git-Zugang nur im Worker, schreibgeschützt:** `~/.ssh`, `~/.config/gh`, `~/.gitconfig` und eine Token-Datei (`/run/secrets/github_token`) werden in der Override-Datei nur im Dienst `worker` mit `read_only: true` eingebunden. Hält `gh` den Token im Schlüsselbund (macOS, Windows), legt der Assistent ihn privat (0600) unter `~/.config/aideation/github-token` ab (`saveGitHubToken`). Der Entrypoint setzt `GH_TOKEN` nur für den Worker-Prozess. Agent-Container bekommen ihn nicht. Anmeldung der Claude-CLI in den Agent-Containern über `CLAUDE_CODE_OAUTH_TOKEN` bzw. `ANTHROPIC_API_KEY` (nur als `-e NAME`).
- **Neustart:** `restart: unless-stopped` ersetzt launchd/systemd. Nach „AIdeation neu starten“ endet der Worker mit Exit-Code 75, Docker startet ihn neu, er lädt den Code aus dem eingebundenen Ordner. `src/runner/system-restart.ts` (Modus `inWorkerContainer`, `DEV_LOG_WORKER_CONTAINER=1`): ermittelt per `docker compose config --services` die Dienste ausser `worker`, `worker-volumes`, `watchdog` und baut und startet nur diese neu (Compose würde sonst den Container ersetzen, in dem der Neubau läuft). Das Worker-Image wird nur gebaut (`docker compose build worker`); es gilt ab dem nächsten Ersetzen des Containers. Liefert `config --services` nichts, bricht der Neustart mit Status `failed` ab, AIdeation läuft unverändert weiter. Die Health-Prüfung nach dem Neubau nutzt `DEV_LOG_HEALTH_URL` (`http://frontend:8080/health`).
- **Healthcheck:** `touchHealthFile` (`DEV_LOG_WORKER_HEALTH_FILE`) erneuert nach jedem erfolgreichen Lebenszeichen in der Datenbank eine Datei; der Container ist gesund, wenn sie jünger als 120 s ist. `start_period` 15 Minuten wegen der ersten `npm ci`-Installation. Das Worker-Badge bleibt an das Lebenszeichen in der Datenbank gebunden.
- **Einrichtungs-Assistent** (`scripts/setup/server.ts`, `wizard.html`, `src/core/env-file.ts`): `workerContainer` (Standard `true`), `claudeToken`, `dockerGid`. `COMPOSE_PROFILES` führt `https` und `worker` zusammen. Wird „Worker im Container“ abgewählt, werden `worker` und `watchdog` entfernt (kein zweiter Worker). Die Host-Skripte `install-worker.sh`, `install-worker-linux.sh`, `install-worker.ps1` sind unverändert und bleiben für den Host-Betrieb.
- **CI** (`.github/workflows/ci.yml`): neuer Schritt „Worker im Container starten und Health prüfen“ (`docker compose --profile worker up -d --build --wait`, `docker version` im Worker, Health = `healthy`). Logs und `down -v` berücksichtigen das Profil.
- **Doku:** `README.md` (Schnellstart, Starten manuell), `docs/installation.md`, `docs/laufzeit.md`.

**Geänderte Dateien:** `.github/workflows/ci.yml`, `.gitignore`, `README.md`, `docker-compose.yml`, `deploy/worker/{Dockerfile,entrypoint.sh}`, `docs/{installation,laufzeit}.md`, `scripts/setup/{server.ts,wizard.html}`, `scripts/start.ps1`, `scripts/worker-compose.ts`, `start.sh`, `src/core/{env-file,env-file.test,sandbox,worker-container,worker-container.test}.ts`, `src/runner/{agent-compose.test,container-hardening.test,runner-cli,system-restart,system-restart.test}.ts`, `src/setup/{worker-compose,worker-compose.test}.ts`. Neu: `deploy/worker/*`, `scripts/worker-compose.ts`, `src/core/worker-container(.test).ts`, `src/setup/worker-compose(.test).ts`.

**Tests (laut Entwickler)**

- `npm test` lokal grün (1750 Tests, 0 Fehler). Die Dokumentation hat ihn nicht selbst ausgeführt.
- `container-hardening.test.ts` liest `docker-compose.yml`: Nur der Dienst `worker` mountet den Docker-Socket (Akzeptanzkriterium).
- `worker-compose.test.ts`: Override-Datei (Pfade, Windows-Format, Git-Zugänge nur im Worker und schreibgeschützt, eigene Dateien werden nicht überschrieben).
- `system-restart.test.ts`: Container-Modus, Dienstliste, Abbruch ohne Dienste. `worker-container.test.ts`, `env-file.test.ts`, `agent-compose.test.ts`: Pfade, Profile, Compose-Datei.

**Nicht geprüft (offen, gehört ins Auftragsprotokoll)**

- Docker war beim Entwickler nicht verfügbar: Image-Build und der neue CI-Schritt sind ungetestet.
- Manuelle Abnahme unter frischem Linux (`./start.sh`, Testauftrag) und Windows mit Docker Desktop (`start.cmd`, Testauftrag) steht aus. Ebenso „AIdeation neu starten“ mit grünem Worker-Badge. Das Ergebnis ist hier einzutragen.
- Grösstes Risiko: ob Docker Desktop unter Windows die `/c/…`-Pfade aus dem Linux-Container (für `docker run`-Mounts der Agent-Container) auflöst.

**Worauf zu achten ist**

- Ohne Profil `worker` in `COMPOSE_PROFILES` gibt es keinen Worker-Container; wer den Host-Worker nutzt, darf das Profil nicht setzen (zwei Worker).
- `docker-compose.override.yml` wird bei jedem Start neu geschrieben, solange die erste Zeile den Marker `# Erzeugt von AIdeation` trägt. Eigene Dateien ohne Marker bleiben unverändert (Warnung); darin müssen AIdeation- und Projektordner stehen. Die Datei steht in `.gitignore`.
- Fehlt der AIdeation-Ordner im Container, endet der Entrypoint mit Exit-Code 78 und einer Meldung.
- Der erste Start dauert einige Minuten (`npm ci`).
- Der Worker-Container hat den Docker-Socket und ist damit praktisch root-äquivalent auf dem Docker-Host. Er ist der einzige Dienst damit; Agent-Container bekommen weder Socket noch Git-Zugang.
- Das Worker-Image selbst wird beim „AIdeation neu starten“ nur gebaut; ein neues Image wirkt erst nach `docker compose up -d` (z. B. `./start.sh`). Änderungen am Code wirken sofort.
- `docs/tests/2026-10-28_23-36/` ist ein untracked Testbericht eines früheren Laufs, nicht Teil dieses Auftrags.
- Die Bug-Wächter-Einträge („monthly spend limit“) sind Budget-Abbrüche, keine Code-Fehler.

## Sprint

Sprint „Isolation“ (Sammelauftrag 36217529):

| Phase | Auftrag | Inhalt | Zustand |
| --- | --- | --- | --- |
| 1 | ef52246b | Entwickler-Agent im Container | gemergt |
| 2 | 2cb9201f | Dienste über Worker-Aktionen | gemergt |
| 3 | 4a7d5cbe | alle Rollen und Test-Gate im Container | gemergt |
| 4 (optional) | 8566b14a | Worker als Compose-Dienst | Entwickler fertig (Commit b303949), Dokumentation hier, Tester/Review/Merge und manuelle Abnahme offen |

## Anfrage / TODO

- Manuelle Abnahme unter frischem Linux (`./start.sh`) und Windows mit Docker Desktop (`start.cmd`): Testauftrag durchlaufen lassen, Ergebnis im Auftrag festhalten.
- Prüfen, dass Agent-Container unter Windows die `/c/…`-Mounts erhalten.
- „AIdeation neu starten“ auslösen: Worker-Container läuft wieder, Badge grün.
- CI-Job `docker` mit dem neuen Worker-Schritt laufen lassen.
- Aus Phase 3 offen: `git rm`/`git mv` im Container (Löschen und Umbenennen durch Agents mit Sandbox `docker`), `@@SERVICES` in Workflow-Läufen, Gruppe „Dienst-Logs“ plattformneutral.
- Bug-Wächter-Aufträge nach dem Limit-Reset erneut anstossen.

## Technische Dokumentation

- `docs/installation.md`: Worker im Container (Profil, Override-Datei, Git-Zugänge, Host-Skripte als Alternative).
- `docs/laufzeit.md`: Laufzeit-Diagramm mit Worker- und Watchdog-Dienst.
- `README.md`: „Schnellstart“ und „Starten (manuell)“.
- Code: `docker-compose.yml` (Dienste `worker`, `worker-volumes`, `watchdog`), `deploy/worker/`, `src/setup/worker-compose.ts`, `src/core/worker-container.ts`, `src/runner/system-restart.ts`.

Ablauf:

1. `./start.sh` bzw. `start.cmd` ruft `scripts/worker-compose.ts` auf und schreibt `docker-compose.override.yml` (Pfade, Git-Zugänge).
2. `docker compose up -d` startet `db`, `dev-log`, `frontend`, `worker-volumes`, `worker`, `watchdog`.
3. Der Worker installiert bei Bedarf `node_modules`, startet Agent-Container über den Socket (Pfade identisch zum Host) und schreibt das Lebenszeichen, das Badge und Healthcheck speisen.
4. „AIdeation neu starten“: Git-Stand holen, Dienste ausser Worker/Wächter und Agent-Image bauen, Health prüfen, Exit-Code 75, Docker startet den Worker neu.
