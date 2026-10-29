# Docker-Sandbox Phase 2: Dienste über Worker-Aktionen statt docker/launchctl

## Aufträge

### Auftrag 2cb9201f

Phase 2 von 4 des Konzepts „Agents plattformunabhängig in Docker-Sandbox ausführen“ (Sammelauftrag 36217529). Sprint „Isolation“, Branch `auftrag/2cb9201f-docker-sandbox-phase-2-dienste-u`, Commit 92cf563 (Agent „Entwickler“).

**Ergebnis:** Agents verwalten Dienste nicht mehr per Shell (`docker compose`, `launchctl`). Sie fordern feste Aktionen an, der Worker prüft und führt sie selbst aus. Damit braucht kein Agent-Container den Docker-Socket (wer ihn hat, hat Root auf dem Host), und macOS-Befehle sind aus Rechten und Prompts verschwunden.

**Aktionen:** `services.status`, `services.logs` (Zeilenlimit 1–1000, Standard 200; Zeitraum `15m`/`2h`, höchstens 24 h), `services.restart`, `services.up` (optional mit Build), `services.stop`. Höchstens 10 Dienstnamen je Aktion, höchstens 5 Aktionen je Antwort.

**Anforderung → Umsetzung**

- Anforderung über Werkzeug: Claude-CLI über Marker `@@SERVICES: services.logs api --lines=100 --since=15m` (`service-request.ts`, ausgewertet in `chat.ts`); Ollama über ein neues Werkzeug in `ollama-tools.ts`.
- Prüfung im Worker (`service-actions.ts`, `runServiceAction`), in dieser Reihenfolge: Rolle und Recht „services“, Projektordner, Compose-Datei im Projekt (per `realpath`, auch Links müssen im Projekt bleiben), AIdeation selbst (Start/Stopp/Neustart abgelehnt), unter der Projektsperre die Dienstnamen (`docker compose config --services`), bei `restart`/`up` die aufgelöste Konfiguration (`composeViolation` aus `compose-check.ts`), dann der Befehl per `execFile`-Argumentliste. Ausgabe maskiert (`redactOutput`) und auf 8000 Zeichen gekürzt. `withProjectLock` gibt die Sperre auch bei Fehlern frei.
- Rollen: `assistant`, `developer`, `tester` dürfen alle Aktionen; `routine` nur `status` und `logs`. Rollen mit reinen Leserechten nie.
- `docker`, `docker compose` und `launchctl` sind aus Standardregeln (`permission-rules.ts`), Wächter (`command-checks.ts`, `agent-guard.ts`) und fester Befehlsliste des Ollama-Pfads entfernt. Die frühere Gruppe „Docker-Dienste“ entfällt.
- Gruppe „services“ (Label „Projekt-Dienste“) ist betriebssystem-neutral und enthält keine Shell-Regel mehr, sie schaltet nur die Aktionen frei.
- Migration (`legacy-rules.ts`, `normalizeCommands`, `normalizeGroups`): Alte gespeicherte Regeln `Bash(launchctl kickstart|list …)` (jede Benutzer-ID, jeder Dienstname) und `Bash(docker compose …)`, `docker ps/logs` werden beim Laden zu „services“; die Gruppe `docker` zählt als „services“. Idempotent.
- Prompt des Assistenten (`chat.ts`, `ollama-prompts.ts`): ohne `~/Library/Logs`, `launchctl`, `lsof`. Logs über `services.logs`, Neustart über `services.restart`.
- Projekt-Assistent (`setup-jobs.ts`, `launchdServicesFor`, Anzeige in `project-wizard.component.*`): Projekte mit launchd-Diensten im Ordner (`~/Library/LaunchAgents`) bekommen einen Hinweis; zusätzlich wird erkannt, ob eine Compose-Datei im Ordner liegt (`compose`).

**Geänderte Dateien:** `README.md`, `docs/agents-und-rechte.md`, `e2e/app.spec.ts`, `frontend/public/data/agent-rollen-texte.json`, `frontend/src/app/features/docs/marketing/agent-permissions.{ts,component.ts,component.html,spec.ts}`, `frontend/src/app/features/projects/project-wizard.component.{ts,html}`, `src/agent/{agent-guard,agent-guard.test,agent-permissions.test,chat,chat.test,command-checks,compose-check,legacy-rules (neu),ollama-agent,ollama-agent.test,ollama-prompts,ollama-prompts.test,ollama-tools,ollama-tools.test,permission-rules,requirements,service-actions (neu),service-actions.test (neu),service-request (neu),tool-permissions,tool-permissions.test}.ts`, `src/api/agent-tasks.ts`, `src/setup/setup-jobs.ts`, `src/setup/setup.test.ts`.

**Tests (laut Entwickler)**

- `chat.test.ts`: Neustart über `@@SERVICES`, Ergebnis im Chat.
- `agent-guard.test.ts`, `tool-permissions.test.ts`: `docker compose up -d` per Shell ist für jede Rolle gesperrt.
- `service-actions.test.ts`: kein `launchctl` in `permission-rules.ts`, `chat.ts`, `ollama-prompts.ts`; `services.up` mit Compose-Datei ausserhalb des Projekts abgelehnt; Sperre wird bei Fehlern freigegeben.
- `agent-permissions.test.ts`: alte `launchctl`-Regel wird zu „services“.
- Die Dokumentation hat `npm test`, `npm run typecheck` und `npm run test:e2e` nicht selbst ausgeführt.

**Worauf zu achten ist**

- Aktionen laufen nur im Worker. Die Marker `@@SERVICES` werden bisher nur im Chat/Assistenten ausgewertet, **nicht** in Workflow-Läufen (`runner-agent.ts`). Das ist Aufgabe von Phase 3.
- Die Gruppe „Dienst-Logs“ (`~/Library/Logs`) ist noch macOS-spezifisch und in Phase 3 plattformneutral zu machen oder zu ersetzen.
- Projekte, die noch launchd nutzen, müssen auf Compose umgestellt werden; der Neustart der Live-Dienste läuft nur noch über Compose.
- Die Doku ist an vier Stellen gleichzeitig zu pflegen: `docs/agents-und-rechte.md`, README „Ablauf“, `agent-permissions.ts`, `agent-rollen-texte.json` (hier geschehen).
- Die bekannten Alt-Bugs („monthly spend limit“ des Bug-Wächters) sind Budget-Abbrüche, keine Code-Fehler dieses Auftrags.

## Sprint

Sprint „Isolation“ (Konzept „Agents in Docker-Sandbox“, Sammelauftrag 36217529):

| Phase | Auftrag | Inhalt | Zustand |
| --- | --- | --- | --- |
| 1 | ef52246b | Entwickler-Agent im Container | gemergt (siehe `docker-sandbox-phase-1-entwickler-agent-im-container-2026-10-29.md`) |
| 2 | 2cb9201f | Dienste über Worker-Aktionen | Entwickler fertig (Commit 92cf563), Dokumentation hier, Review/Merge offen |
| 3 | – | weitere Rollen in der Sandbox, `@@SERVICES` in Workflow-Läufen | offen, braucht Phase 2 |
| 4 | – | laut Sammelauftrag | offen |

## Anfrage / TODO

- Phase 3: `@@SERVICES` in `runner-agent.ts` auswerten; Gruppe „Dienst-Logs“ (`~/Library/Logs`) plattformneutral machen.
- Vor dem produktiven Einsatz mit echtem Docker prüfen: `services.status` und `services.restart` an einem Projekt mit Compose-Datei; ein Projekt mit launchd-Dienst im Projekt-Assistenten (Hinweis erscheint).
- Phase 1 offen: Dockerfile bauen und `sandbox-docker.test.ts` mit `DEV_LOG_TEST_REQUIRE_DOCKER=1` ausführen.
- Bug-Wächter-Aufträge wegen Budgetlimit erneut anstossen, sobald das Limit zurückgesetzt ist.

## Technische Dokumentation

Siehe `docs/agents-und-rechte.md` (Abschnitte 3 und 4: Gruppe „services“, Aktionen, Migration) und die Modulkommentare in `src/agent/service-request.ts` (Form und Validierung einer Anfrage, ohne Abhängigkeiten, damit auch der gebündelte Wächter im Container die Namen kennt) und `src/agent/service-actions.ts` (Prüfung und Ausführung im Worker). Ablauf einer Anfrage:

1. Agent: Marker oder Ollama-Werkzeug → `parseServiceRequest`/`parseServiceMarker` (Namen, Zeilen, Zeitraum, Datei validiert).
2. Worker: `serviceRoleProblem` → `composeFileFor` → Selbstschutz → `withProjectLock` → Dienstnamen → `composeViolation` (nur bei Start) → `docker compose …` per Argumentliste.
3. Ergebnis (maskiert, gekürzt) geht als Abschnitt „Dienst-Aktionen“ (`serviceResultsSection`) bzw. Werkzeugantwort an den Agent zurück.
