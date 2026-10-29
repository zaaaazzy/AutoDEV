# Benutzerhandbuch: Alle Rollen und Test-Gate im Container (Docker-Sandbox Phase 3)

Dieses Kapitel beschreibt Auftrag 4a7d5cbe. Alle Agent-Rollen und das Projekttests-Gate laufen jetzt in der Docker-Sandbox. Der Host führt keinen Code mehr aus, den Agents geschrieben haben. Die Sandbox ist der Standard. Für dich heisst das: Du brauchst das Image `aideation-agent`, und ohne es laufen Agent-Schritte nicht. Es gibt keinen stillen Rückfall auf den Host.

> **Printscreens:** keine. In dieser Sitzung wurde die App nicht gestartet, und es gab keinen Browser-Lauf. Das Image wurde nicht gebaut, und Docker war nicht geprüft. Die Beschreibung stammt aus dem Quelltext des Auftrags-Branches (`src/core/sandbox.ts`, `src/core/egress-proxy.ts`, `src/runner/test-sandbox.ts`, `src/runner/visual-sandbox.ts`, `src/agent/compose-check.ts`, `frontend/src/app/features/settings/settings.component.html`, `frontend/src/app/features/docs/marketing/agent-permissions.component.html`) und aus `docs/docker-sandbox-phase-3-alle-rollen-und-test-gate-im-container-2026-10-29.md`. Abschnitt 11 nennt die Aufnahmen, die noch fehlen.
>
> **Stand:** Der Code liegt auf dem Branch `auftrag/4a7d5cbe-docker-sandbox-phase-3-alle-roll` (Commit 02f19cd, Entwickler). Die Tests `npm test`, `npm run typecheck` und `npm run test:e2e` hat dieses Kapitel nicht ausgeführt. Ob die Akzeptanzkriterien mit echtem Docker erfüllt sind, ist nicht geprüft.

---

## 1. Was sich ändert

Bisher liefen Agents auf dem Host. Sie hatten dieselben Rechte wie dein Benutzer, und Projekttests liefen ebenfalls auf dem Host. Jetzt gilt:

- Jeder Agent-Schritt läuft in einem **eigenen, kurzlebigen Container** aus dem Image `aideation-agent`.
- Das Projekttests-Gate (`npm run test:full` des Projekts und die Tests vor dem Live-Schalten) läuft ebenfalls im Container.
- Der visuelle Tester nimmt seine Screenshots aus dem Container auf, mit Playwright aus dem Image.
- **Git bleibt beim Worker auf dem Host.** Commits, Merges und Branches macht der Worker, nicht der Agent.
- Die Sandbox ist die **Grenze** zum Rechner. Der Wächter (`agent-guard.ts`) bleibt die zweite Linie.

## 2. Der Schalter `DEV_LOG_AGENT_SANDBOX`

| Wert | Wirkung |
|---|---|
| `docker` (Standard) | Agents und Projekttests laufen im Container. |
| `off` | Notfallmodus. Agents und Projekttests laufen wieder auf dem Host. Im Worker-Badge erscheint eine Warnung. |

- **Global:** Die Variable steht in `worker.env`.
- **Je Projekt:** In den Einstellungen des Projekts gibt es das Feld „Docker-Sandbox für Agents und Projekttests“. Die Auswahl „Wie global (DEV_LOG_AGENT_SANDBOX, Standard Docker)“ übernimmt den globalen Wert. Ein Projekt-Wert hat Vorrang vor dem globalen.
- **Ausdrücklicher Notfallmodus:** Nur `off` schaltet die Sandbox ab. Andere Werte als `off` und `docker` werden ignoriert, dann gilt der Standard `docker`.

Im Worker-Badge zeigt `sandboxStatus` entweder ein Sandbox-Problem (siehe Abschnitt 8) oder die Warnung des Notfallmodus: „Notfallmodus: Docker-Sandbox aus (DEV_LOG_AGENT_SANDBOX=off) – Agents und Projekttests laufen auf dem Host.“

## 3. Welche Rollen im Container laufen

Alle Rollen laufen im Container. Der Unterschied liegt nur darin, ob der Workspace beschreibbar eingebunden wird.

| Rolle | Workspace im Container |
|---|---|
| Autor, Entwickler, Tester, Reviewer, Dokumentierer, Handbuch-Autor, Benutzerhandbuch-Autor, Bug-Wächter | `:rw` (beschreibbar) |
| Assistent (Chat), Routinen | `:rw` |
| Visionär, Problemanalyse, `pre_sprint` und alle Rollen aus `READ_ONLY_ROLES` | **nur `:ro`** (lesbar) |
| Visueller Tester | kein Workspace, siehe Abschnitt 6 |
| System-Agents: Schätzung, Analyse, `readOnlyCommand` | laufen ebenfalls im Container. Die Schätzung sieht einen leeren Ordner, nur lesend. |

**Lesende Rollen** können Dateien im Workspace nicht ändern, weil er als `:ro` eingebunden ist. Zusätzlich sperrt der Wächter (`agent-guard.ts`) Datei-Werkzeuge ohne Schreibrecht und, für Rollen ohne Shell, jeden Shell-Befehl.

## 4. Ablauf eines Agent-Schritts

1. Der Worker wählt den Modus: zuerst das Projekt, sonst `DEV_LOG_AGENT_SANDBOX`, Standard `docker`.
2. Die Sandbox prüft Docker, das Image, das interne Netzwerk und den Egress-Proxy. Schlägt eine Prüfung fehl, bricht der Schritt mit einer Meldung ab.
3. Der Container startet mit dem Label `aideation.run`, im Netzwerk `aideation-agents`, mit den Grenzen CPU `2` und Speicher `4g` (über `DEV_LOG_AGENT_SANDBOX_CPUS` und `DEV_LOG_AGENT_SANDBOX_MEMORY` änderbar).
4. Die Ausgabe läuft durch die Maskierung (`redactOutput`), bevor sie in den Lauf geschrieben wird.
5. Der Container wird am Ende entfernt, auch bei Abbruch.

**Beim Start des Workers** entfernt der Worker übrig gebliebene Sandbox-Container mit dem Label `aideation.run`. So bleiben nach einem Absturz keine Container zurück.

## 5. Projekttests und Dienste im Container

Projekttests (Tester-Schritt, Gate beim Live-Schalten, `npm run test:full`, Abdeckungsmessung) laufen im Container.

- **Ohne Dienste:** Das Projekt braucht nichts weiter. Die Tests laufen im Container gegen den Worktree.
- **Mit Diensten** (z. B. eine Datenbank für die Tests): Markiere den Dienst in der Compose-Datei des Projekts mit dem Label `aideation.test`:

  ```yaml
  services:
    db:
      image: postgres:16
      labels:
        aideation.test: "true"
  ```

  Der Worker prüft die Compose-Datei nach denselben Regeln wie bei `services.up` (Abschnitt 4 aus Phase 2). Er startet die markierten Dienste im Compose-Projekt der Agent-Kopie. Der Testcontainer hängt nur an dieses Netzwerk, nicht an das LAN und nicht an die AIdeation-Datenbank.

- **Ein Testbefehl, der `~/.ssh` des Hosts liest,** scheitert im Gate. Der Container bindet nur den Worktree ein, keinen Host-Ordner. Das ist der Integrationstest in `sandbox-docker.test.ts`. Er läuft nur mit Docker, ohne Docker wird er übersprungen.

## 6. Netzwerk und Grenzen

**Netzwerk der Agent-Container:** `aideation-agents`, ein internes Docker-Netzwerk (`--internal`). Der Container hat keinen direkten Weg nach draussen.

**Einziger Ausgang:** der Egress-Proxy `aideation-egress`. Er läuft im Image, ohne Rechte und mit `--read-only`.

| Ziel | erlaubt |
|---|---|
| `api.anthropic.com:443` | ja |
| `registry.npmjs.org:443` (npm) | ja |
| `host.docker.internal:11434` (Ollama auf dem Host) | ja |
| weitere Ziele | nur über `DEV_LOG_AGENT_SANDBOX_EGRESS` (Format `host:port,host:port`) |
| rohe IP-Adressen | gesperrt |
| Namen, die auf private Adressen auflösen | gesperrt (DNS-Rebinding) |

**Nicht erreichbar aus einem Agent-Container:** das LAN und die AIdeation-Datenbank (`db:5432` und `127.0.0.1:5433`). Ein Test dafür ist im Integrationstest `sandbox-docker.test.ts` vorgesehen.

**Lesende Rollen:** Ein Test in `sandbox.test.ts` prüft, dass sie den Workspace nur mit `:ro` einbinden.

## 7. Visueller Tester

Der visuelle Tester (`visual-sandbox.ts`, `visual-capture-cli.ts`) nimmt Screenshots für **Desktop und Handy** auf.

- Playwright und das Skript `/opt/aideation/visual-capture.mjs` liegen im Image. Es gibt keine Playwright-Installation mehr auf dem Host.
- Der Container bindet **keinen Worktree** ein.
- Er hängt am **Bridge-Netz** (nicht am internen Netz), damit er die Vorschau erreicht. `localhost` des Hosts heisst im Container `host.docker.internal`.
- Login-Daten für Tests gehen nur als **Variablenname** an den Container (`-e NAME`), nicht als Wert auf der Kommandozeile.

## 8. Fehler: fail-closed

Fehlt etwas, scheitert der Schritt mit einer Meldung. Es gibt keinen Rückfall auf den Host.

| Meldung (sinngemäss) | Ursache | Abhilfe |
|---|---|---|
| „Docker ist nicht erreichbar – der Agent wurde nicht gestartet“ | Docker Desktop läuft nicht oder ist nicht erreichbar | Docker starten |
| „Image „aideation-agent“ fehlt“ | das Image wurde nicht gebaut | Image bauen (Abschnitt 10) |
| „Egress-Proxy „aideation-egress“ startet nicht“ oder „hängt nicht im Agent-Netzwerk“ | Proxy-Container fehlt oder startet nicht | Meldung im Lauf lesen, dann Image neu bauen |
| Netzwerk „aideation-agents“ ist nicht intern | ein gleichnamiges Netzwerk existiert ohne `--internal` | Netzwerk entfernen, der Worker legt es neu an |
| Agent löscht oder benennt eine Datei um (`git rm`, `git mv`) | kein Fehler in der Sandbox, sondern eine Lücke: siehe Abschnitt 9 | bis Phase 4: Datei von Hand löschen oder umbenennen und committen |

Limit- und Anmeldefehler der Claude-CLI werden getrennt von Docker-Fehlern gekennzeichnet. Ob ein Abbruch durch das Anthropic-Ausgabelimit als „pausiert“ gilt und den Wiederholungszähler **nicht** erhöht, ist im Quelltext nicht belegt und noch zu prüfen (siehe Abschnitt 11).

## 9. Bedingungen auf einen Blick

| Bedingung | Was passiert |
|---|---|
| `DEV_LOG_AGENT_SANDBOX` nicht gesetzt | Sandbox `docker` (Standard) |
| `DEV_LOG_AGENT_SANDBOX=off` | Host-Ausführung, Warnung im Worker-Badge |
| Projekt-Einstellung „Wie global“ | es gilt der globale Wert |
| Projekt-Einstellung ungleich „Wie global“ | der Projekt-Wert gewinnt |
| Image fehlt, Docker aus, Netzwerk oder Proxy fehlen | Schritt abgebrochen, Meldung, kein Rückfall |
| Rolle ist lesend (Visionär, Problemanalyse, `pre_sprint`, `READ_ONLY_ROLES`) | Workspace nur `:ro` |
| Projekt-Dienst mit Label `aideation.test: "true"` | wird im Compose-Projekt der Agent-Kopie gestartet und nur an dessen Netzwerk gehängt |
| Ziel ausserhalb der Allowlist | vom Egress-Proxy abgelehnt |
| Visueller Tester | kein Worktree, Bridge-Netz, Playwright aus dem Image |
| Agent will eine Datei löschen oder umbenennen (`git rm <pfad>`, `git mv <alt> <neu>`) bei Sandbox `docker` | Der Wächter lässt den Befehl zu (er braucht die Rechte „Dateien ändern“ bzw. zusätzlich „Dateien anlegen“). Im Container schlägt er aber fehl, weil der Git-Ordner des Hauptprojekts nicht eingebunden ist (siehe Abschnitt 11). Das ist nicht im Container ausgeführt. |

## 10. Voraussetzungen: Image bauen

Ohne Image laufen keine Agent-Schritte. Das Image steht in `deploy/agent/Dockerfile` und bündelt den Egress-Proxy, das Visual-Capture-Skript und Playwright.

- Image bauen: siehe `docs/installation.md`.
- Nach Code-Änderungen den Worker neu starten.
- Ein Projekt, das Tests mit Diensten braucht, muss die Dienste mit `aideation.test: "true"` markieren (Abschnitt 5).

## 11. Noch offen

- **Akzeptanzkriterien mit echtem Docker:** Ein vollständiger Auftrag (Autor bis Benutzerhandbuch-Autor) mit Standardeinstellungen ist nicht durchlaufen. Auch nicht geprüft: jeder Schritt hat einen eigenen Container mit Label `aideation.run`.
- **Integrationstests:** `sandbox-docker.test.ts` (`~/.ssh` nicht lesbar, Datenbank nicht erreichbar) ist mit `DEV_LOG_TEST_REQUIRE_DOCKER=1` noch nicht gelaufen.
- **Visueller Tester:** Desktop- und Handy-Screenshots aus dem Container sind nicht erzeugt.
- **Löschen und Umbenennen durch Agents (Lücke):** Der Wächter erlaubt `git rm <pfad>` und `git mv <alt> <neu>` (Regeln in `src/agent/command-checks.ts`, Funktion `gitFileProblem`). Im Container wirken sie aber nicht: Der Container bindet nur den Worktree ein (`src/core/sandbox.ts`), und der Git-Ordner des Hauptprojekts liegt ausserhalb davon. Mit dem Standard `docker` können Agents darum keine Dateien löschen oder umbenennen. Der Entwickler sieht das als Kandidat für Phase 4. Der Befehl ist im Container nicht ausgeführt, die Ursache ist aus dem Code und dem Dokumentierer-Hinweis abgeleitet.
- **Tests zu `git rm` und `git mv`:** Nicht ausgeführt. Die Angabe „bestanden“ aus dem Entwickler-Bericht ist nicht nachgeprüft.
- **Limit-Abbruch:** Die Erkennung als „pausiert/Limit“ und das Nicht-Hochzählen des Wiederholungszählers sind nicht geprüft.
- **`@@SERVICES` in Workflow-Läufen** (`runner-agent.ts`) und die Gruppe „Dienst-Logs“ (`~/Library/Logs`) sind noch macOS-spezifisch. Das ist aus Phase 2 offen.
- **Tests:** `npm test`, `npm run typecheck` und `npm run test:e2e` sind nicht in diesem Kapitel gelaufen.

## 12. Printscreens, die noch fehlen

Für ein vollständiges Handbuch sollten diese Aufnahmen entstehen (mit laufender App, Docker und dem gebauten Image):

1. **Einstellungen des Projekts:** Feld „Docker-Sandbox für Agents und Projekttests“ mit den Optionen.
2. **Worker-Badge im Normalbetrieb:** ohne Warnung.
3. **Worker-Badge im Notfallmodus `off`:** die Warnung.
4. **Worker-Badge bei Sandbox-Problem:** zum Beispiel Image fehlt.
5. **Marketing-Seite „Agent-Rechte“:** Abschnitt „Grenze – die Docker-Sandbox“.
6. **Lauf-Ansicht:** ein Agent-Schritt mit Container-Hinweis.

---

*Quelle: Auftrag 4a7d5cbe, Branch `auftrag/4a7d5cbe-docker-sandbox-phase-3-alle-roll`, Commit 02f19cd (Entwickler), `docs/docker-sandbox-phase-3-alle-rollen-und-test-gate-im-container-2026-10-29.md`. Nicht committet.*
