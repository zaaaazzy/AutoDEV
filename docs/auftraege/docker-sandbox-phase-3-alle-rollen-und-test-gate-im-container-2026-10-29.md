# Docker-Sandbox Phase 3: alle Rollen und Test-Gate im Container

## Aufträge

### Auftrag 4a7d5cbe

Phase 3 von 4 des Konzepts „Agents plattformunabhängig in Docker-Sandbox ausführen“ (Sammelauftrag 36217529). Sprint „Isolation“, Branch `auftrag/4a7d5cbe-docker-sandbox-phase-3-alle-roll`, Commit 02f19cd (Agent „Entwickler“). Setzt Phase 1 und 2 voraus.

**Ergebnis:** Alle Agent-Rollen und das Projekttests-Gate laufen in der Docker-Sandbox. Der Host führt keinen Code mehr aus, den Agents geschrieben haben. `DEV_LOG_AGENT_SANDBOX` steht standardmässig auf `docker`. `off` bleibt als ausdrücklicher Notfallmodus und zeigt im Worker-Badge eine Warnung.

**Anforderung → Umsetzung**

- Alle Rollen im Container (`src/core/sandbox.ts`, `src/runner/runner-agent.ts`, `runner-steps.ts`, `runner-cli.ts`): Autor, Entwickler, Tester, Reviewer, Dokumentierer, (Benutzer-)Handbuch-Autor, Bug-Wächter, Assistent (Chat), Routinen, Visionär, Problemanalyse und `pre_sprint`. Jeder Agent-Schritt bekommt einen eigenen, kurzlebigen Container aus dem Image `aideation-agent` (Label `aideation.run`).
- Lesende Rollen (`READ_ONLY_ROLES`, Visionär, Problemanalyse, `pre_sprint`) binden den Workspace nur mit `:ro` ein.
- System-Agents (Schätzung im leeren Ordner `:ro`, Analyse, `readOnlyCommand`) laufen über `runInSandbox` (`src/agent/estimation.ts`, `src/agent/requirements.ts`).
- Projekttests im Container (`src/runner/test-sandbox.ts`, angebunden in `test-agent.ts`, `test-request.ts`): Tester-Schritt, Gate beim Live schalten, Komplettlauf `npm run test:full`, Abdeckungsmessung. Git bleibt beim Worker. Dienste, die Tests brauchen (z. B. Datenbank), markiert das Projekt in der Compose-Datei mit dem Label `aideation.test: "true"`. Der Worker prüft sie wie `services.up` (`composeViolation`), startet sie im Compose-Projekt der Agent-Kopie und hängt den Testcontainer nur an dieses Netzwerk.
- Netzwerk: internes Docker-Netzwerk `aideation-agents` (`--internal`). Einziger Ausgang ist der Egress-Proxy `aideation-egress` (`src/core/egress-proxy.ts`, im Image gebündelt, ohne Rechte, `--read-only`). Erlaubt: `api.anthropic.com:443`, `registry.npmjs.org:443`, `host.docker.internal:11434` (Ollama). Weitere Ziele nur über `DEV_LOG_AGENT_SANDBOX_EGRESS` (`host:port,…`). Rohe IP-Adressen und Namen, die auf private Adressen auflösen, sind gesperrt. LAN und AIdeation-Datenbank (`db:5432`, `127.0.0.1:5433`) sind damit nicht erreichbar.
- Visueller Tester: Playwright aus dem Image (`/opt/aideation/visual-capture.mjs`; `visual-sandbox.ts`, `visual-capture-cli.ts`), Screenshots für Desktop und Handy. Der Container bindet keinen Worktree ein und hängt am Bridge-Netz; `localhost` des Hosts heisst dort `host.docker.internal`. Test-Login-Daten gehen nur als Name (`-e`) weiter.
- Fail-closed: Fehlen Docker, Image, Anmeldung, internes Netzwerk oder Proxy, scheitert der Schritt mit Meldung (auch im Worker-Badge). Es gibt keinen Rückfall auf den Host. Limit- und Anmeldefehler der Claude-CLI werden getrennt von Docker-Fehlern gekennzeichnet (Hinweis des Bug-Wächters zum „monthly spend limit“).
- Worker-Badge: `sandboxStatus` (`test-sandbox.ts`) zeigt Sandbox-Probleme oder die Warnung des Notfallmodus `off`. Der Schalter gilt global (`worker.env`) oder je Projekt (`projects.agent_sandbox`, Einstellungen).
- `deploy/agent/Dockerfile`: bündelt Egress-Proxy und Visual-Capture-Skript und bringt Playwright mit. `scripts/test.env` ergänzt Testwerte.

**Geänderte Dateien:** `README.md`, `deploy/agent/Dockerfile`, `docs/{agents-und-rechte,installation,laufzeit}.md`, `frontend/src/app/core/models.ts`, `frontend/src/app/features/docs/marketing/agent-permissions.{component.html,spec.ts}`, `frontend/src/app/features/settings/settings.component.html`, `scripts/test.env`, `src/agent/{estimation,requirements}.ts`, `src/core/{egress-proxy,egress-proxy.test,sandbox,sandbox.test,sandbox-docker.test}.ts`, `src/runner/git-sync/sprint-sync.ts`, `src/runner/{runner-agent,runner-cli,runner-steps,runner-types,test-agent,test-request,test-sandbox,test-sandbox.test,visual-capture-cli,visual-sandbox}.ts`. Neu: `egress-proxy(.test).ts`, `sandbox-docker.test.ts`, `test-sandbox(.test).ts`, `visual-sandbox.ts`.

**Tests (laut Entwickler)**

- `egress-proxy.test.ts`: Allowlist, Zielparsing, private Adressen gesperrt.
- `sandbox.test.ts`: Standardmodus `docker`, lesende Rollen nur `:ro`, Container-Argumente.
- `test-sandbox.test.ts`: Projekttests und Dienste im Container.
- `sandbox-docker.test.ts` (Integration, ohne Docker übersprungen; mit `DEV_LOG_TEST_REQUIRE_DOCKER=1` erzwingbar): Testbefehl liest `~/.ssh` nicht, AIdeation-Datenbank ist nicht erreichbar.
- `agent-permissions.spec.ts` (Frontend) gleicht Marketing-Seite mit Doku ab.
- Die Dokumentation hat `npm test`, `npm run typecheck` und `npm run test:e2e` nicht selbst ausgeführt. Ob die Akzeptanzkriterien mit echtem Docker (voller Auftrag, Screenshots aus dem Container) erfüllt sind, ist ungeprüft.

**Worauf zu achten ist**

- Das Image `aideation-agent` muss gebaut sein (`deploy/agent/Dockerfile`). Sonst scheitern alle Agent-Schritte mit Meldung; es gibt keinen Rückfall. Nur `DEV_LOG_AGENT_SANDBOX=off` schaltet die Sandbox ab (Warnung im Badge).
- Die Sandbox ist jetzt die Grenze zum Rechner, der Wächter (`agent-guard.ts`) die zweite Linie.
- Ein nicht internes Netzwerk namens `aideation-agents` sperrt den Lauf bewusst.
- Der visuelle Tester hängt am Bridge-Netz (nicht am internen), damit er die Vorschau erreicht; er hat keinen Worktree.
- Projekte, die für Tests Dienste brauchen, müssen sie mit `aideation.test: "true"` markieren.
- Nach Code-Änderungen den Worker neu starten.
- **Bekannte Lücke (Merge von main, `docs/agents-loeschen-und-umbenennen-git-rm-mv-2026-10-28.md`):** Der Wächter erlaubt Löschen und Umbenennen nur noch über `git rm <pfad>` und `git mv <alt> <neu>`. Im Container sind diese Befehle wirkungslos, weil der Git-Ordner des Hauptprojekts nicht eingebunden ist. Mit Sandbox-Standard `docker` können Agents darum keine Dateien löschen oder umbenennen. Der Entwickler sieht das als Kandidat für Phase 4.
- Der Entwickler sollte laut Nachricht einen Abbruch durch das Anthropic-Ausgabelimit als „pausiert/Limit“ erkennen. In der Änderungsliste ist dazu nur die Kennzeichnung von Limit-Fehlern belegt. Ob der Wiederholungszähler dabei wirklich nicht hochzählt, ist zu prüfen.
- Die Bug-Wächter-Bugs („monthly spend limit“) sind Budget-Abbrüche, keine Code-Fehler.
- `docs/tests/2026-10-28_23-36/` ist ein untracked Testbericht eines früheren Laufs, nicht Teil dieses Auftrags.

## Sprint

Sprint „Isolation“ (Sammelauftrag 36217529):

| Phase | Auftrag | Inhalt | Zustand |
| --- | --- | --- | --- |
| 1 | ef52246b | Entwickler-Agent im Container | gemergt |
| 2 | 2cb9201f | Dienste über Worker-Aktionen | gemergt |
| 3 | 4a7d5cbe | alle Rollen und Test-Gate im Container, Egress-Proxy, Standard `docker` | Entwickler fertig (Commit 02f19cd), Dokumentation hier, Tester/Review/Merge offen |
| 4 | – | laut Sammelauftrag | offen, braucht Phase 3 |

## Anfrage / TODO

- Image bauen und `sandbox-docker.test.ts` mit `DEV_LOG_TEST_REQUIRE_DOCKER=1` ausführen (`~/.ssh`-Test, Datenbank-Sperre).
- Einen vollständigen Auftrag (Autor bis Benutzerhandbuch-Autor) mit Standardeinstellungen durchlaufen lassen und prüfen, dass jeder Schritt einen eigenen Container mit Label `aideation.run` hat und nach Abbruch keine Container oder Job-Sperren zurückbleiben.
- Visuellen Tester gegen eine echte Vorschau laufen lassen (Desktop- und Handy-Screenshots).
- `@@SERVICES` in Workflow-Läufen (`runner-agent.ts`) und die Gruppe „Dienst-Logs“ (`~/Library/Logs`) plattformneutral machen (offen aus Phase 2, bisher nicht in der Änderungsliste).
- Limit-Abbruch als „pausiert“ ohne Wiederholungszähler prüfen.
- Bug-Wächter-Aufträge nach dem Limit-Reset erneut anstossen.
- Phase 4 planen, darin `git rm`/`git mv` im Container ermöglichen (Löschen und Umbenennen durch Agents mit Sandbox `docker`).

## Technische Dokumentation

- `docs/agents-und-rechte.md` (Abschnitt „Docker-Sandbox“, ab „Grenze“): Rollen, Mounts, Netzwerk, Egress, Projekttests, visueller Tester, Fail-closed.
- `docs/laufzeit.md`: Diagramm mit „Host“ und Teilgraph „Docker-Sandbox · Netzwerk aideation-agents“ samt Egress-Proxy.
- `docs/installation.md`: Image bauen und Schalter.
- README „Grenzen der Agent-Rechte“; Marketing-Seite `agent-permissions.component.html`.

Ablauf eines Agent-Schritts:

1. Worker wählt Modus (`sandboxMode`: Projektwert `projects.agent_sandbox`, sonst `DEV_LOG_AGENT_SANDBOX`, Standard `docker`).
2. `runInSandbox` prüft Docker, Image, internes Netzwerk und Egress-Proxy; Fehler brechen den Schritt ab.
3. Container mit Label `aideation.run`, Workspace `:rw` bzw. `:ro` für lesende Rollen, Netzwerk `aideation-agents`.
4. Ausgabe läuft durch `redactOutput`; der Container wird bei jedem Ende (auch Abbruch) entfernt. Git-Schritte macht der Worker auf dem Host.
