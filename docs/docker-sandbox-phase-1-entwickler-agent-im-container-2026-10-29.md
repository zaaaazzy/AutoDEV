# Docker-Sandbox Phase 1: Entwickler-Agent im Container

Auftrag ef52246b (Phase 1 von 4 des Konzepts „Agents plattformunabhängig in Docker-Sandbox ausführen“, Sammelauftrag 36217529).

## Ergebnis

Der Entwickler-Agent läuft auf Wunsch in einem kurzlebigen Docker-Container (Image `aideation-agent`) statt auf dem Host. Der Worker bleibt auf dem Host, steuert den Lauf und committet auf den Auftrags-Branch. Schalter `DEV_LOG_AGENT_SANDBOX` = `off` (Standard) | `docker`, global (in `worker.env`) und je Projekt (Einstellungen → Projekt & Ordner). Der Projektwert geht vor. Nur die Rolle `developer` nutzt die Sandbox.

## Umsetzung

- **Image** (`deploy/agent/Dockerfile`): Basis Playwright mit Node 22, Claude-CLI in fester Version (Build-Argument `CLAUDE_CODE_VERSION`), Git, ripgrep, gebündelter Wächter unter `/opt/aideation/agent-guard.mjs`. Läuft ohne Root. Gebaut beim Neustart (`src/runner/system-restart.ts`) und im CI-Job `docker` (`.github/workflows/ci.yml`).
- **`src/core/sandbox.ts`:** `runInSandbox` baut den `docker run`-Aufruf (`sandboxRunArgs`) und liefert dasselbe `CommandResult` wie `runCommand` (Streaming, Timeout, Prozessregister, `redactOutput`). Optionen: `--rm`, `--cap-drop ALL`, `--security-opt no-new-privileges`, CPU-/Speicher-/Prozesslimit (`DEV_LOG_AGENT_SANDBOX_CPUS` Standard 2, `DEV_LOG_AGENT_SANDBOX_MEMORY` Standard 4g), Label `aideation.run=<Lauf-ID>`, `--user <uid>:<gid>` (unter Windows weggelassen).
- **Mounts:** nur der Worktree als `/workspace` (rw) und das Volume `aideation-node-modules-<projekt>`. Kein Docker-Socket, kein Home, kein SSH- oder Claude-Ordner des Hosts, keine Umgebungsdatei des Hosts. Windows-Pfade für `-v` werden umgewandelt (`dockerHostPath`).
- **Anmeldung:** `CLAUDE_CODE_OAUTH_TOKEN` oder `ANTHROPIC_API_KEY` aus `worker.env`; im Aufruf steht nur `-e NAME`, der Wert kommt über die Umgebung des Docker-Clients (`dockerClientEnvironment` reicht nur PATH, Docker-Kontext, Proxy und Anmeldedaten durch). Nie in Argumenten oder Logs.
- **Ollama:** `DEV_LOG_OLLAMA_URL=http://host.docker.internal:11434`, unter Linux mit `--add-host host.docker.internal:host-gateway`. Shell-Befehle des lokalen Modells laufen im Container (`sandboxExecutor`), seine Datei-Werkzeuge weiter im Worker.
- **Wächter:** `guardHookCommand` und die Berechtigungen in `src/agent/tool-permissions.ts` erhalten einen optionalen `GuardLocation`, damit der Hook im Container den gebündelten Wächter aufruft. `.dev-log-backups/` bleibt im Worktree.
- **Runner:** `src/runner/runner-agent.ts` entscheidet pro Schritt (`usesSandbox`, `projectSandbox`), nutzt im Container `/workspace` als cwd und lässt die Log-Ordner (`--add-dir`) weg. `runner-types.ts` trägt die Einstellung.
- **Fail-closed:** `sandboxProblem` prüft Docker und Image, `credentialProblem` die Anmeldung. Bei Fehlern scheitert der Schritt mit Meldung, `sandboxBadge` zeigt sie im Worker-Badge (`runner-cli.ts`). Nichts läuft auf dem Host. `sandboxFailureNote` kennzeichnet Limit- und Anmeldefehler der Claude-CLI getrennt von Docker-Fehlern.
- **Abbruch und Aufräumen:** Abbruch und Timeout führen `docker kill` aus (Grenze 8 s), danach immer `docker rm -f`, auch bei Fehlern. Der Client steht im Prozessregister. Beim Worker-Start entfernt `removeLeftoverContainers` Container mit Label `aideation.run`.
- **Datenbank:** Migration 18 `agent-sandbox-je-projekt` (`projects.agent_sandbox`, `off`/`docker`, NULL = global). API: `src/api/projects.ts`. Oberfläche: `frontend/src/app/core/models.ts`, `features/settings/settings.component.{ts,html}`.

## Tests

- `src/core/sandbox.test.ts` (Unit): Aufruf enthält `--rm`, `--cap-drop ALL`, `no-new-privileges`; keine Mounts von Socket, SSH-Ordner, Claude-Ordner, Home; Token nicht in den Argumenten; Fehlerfälle und Maskierung.
- `src/core/sandbox-docker.test.ts` (Integration): `~/.ssh` des Hosts und Dateien ausserhalb von `/workspace` nicht lesbar. Wird ohne Docker oder Image übersprungen; mit `DEV_LOG_TEST_REQUIRE_DOCKER=1` erzwungen.
- Die Dokumentation hat die Tests nicht erneut ausgeführt. Laut Bericht des Entwicklers waren die Docker-Tests mangels Image übersprungen, und das Dockerfile wurde noch nie gebaut.

## Geänderte Dateien

`.github/workflows/ci.yml`, `deploy/agent/Dockerfile` (neu), `docs/agents-und-rechte.md`, `docs/installation.md`, `frontend/src/app/core/models.ts`, `frontend/src/app/features/settings/settings.component.html`, `frontend/src/app/features/settings/settings.component.ts`, `src/agent/tool-permissions.ts`, `src/api/projects.ts`, `src/core/sandbox-docker.test.ts` (neu), `src/core/sandbox.test.ts` (neu), `src/core/sandbox.ts` (neu), `src/db/migrations.ts`, `src/runner/runner-agent.ts`, `src/runner/runner-cli.ts`, `src/runner/runner-types.ts`, `src/runner/system-restart.ts`

## Worauf zu achten ist

- **Vor dem produktiven Einsatz prüfen:** `docker build -t aideation-agent -f deploy/agent/Dockerfile .`, dann `DEV_LOG_TEST_REQUIRE_DOCKER=1 npx --no-install tsx --test src/core/sandbox-docker.test.ts`. Besonders das Einbinden des `node_modules`-Volumes über den Symlink im Worktree ist ungeprüft.
- **Git im Container:** Der Git-Ordner des Hauptprojekts ist nicht eingebunden, `git status`/`git diff` funktionieren im Container nicht. Commits macht der Worker auf dem Host.
- **Kein `--resume`:** Fortgesetzte Claude-Sitzungen gibt es im Container nicht, der Schritt startet frisch.
- **Erster Lauf:** Das `node_modules`-Volume ist leer, der Agent installiert mit `npm ci --ignore-scripts`. Zurücksetzen mit `docker volume rm aideation-node-modules-<projekt>`.
- **Limit-Meldungen:** „monthly spend limit“ der Claude-CLI ist kein Sandbox-Fehler (alle bekannten Alt-Bugs sind dieser Art) und wird entsprechend gekennzeichnet.
- **Nächste Phasen:** Andere Rollen laufen weiter auf dem Host. Wer `SANDBOX_ROLES` erweitert, muss Wächter, Mounts und Git-Zugriff je Rolle neu bewerten.
- Siehe auch `docs/agents-und-rechte.md` (Rechte, Grenzen) und `docs/installation.md` (Einrichtung).
