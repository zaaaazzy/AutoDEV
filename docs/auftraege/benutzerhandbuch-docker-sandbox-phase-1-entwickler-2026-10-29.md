# Benutzerhandbuch: Docker-Sandbox für den Entwickler-Agent (Phase 1)

Dieses Kapitel beschreibt die neue Docker-Sandbox aus Auftrag ef52246b. Auf Wunsch läuft der Entwickler-Agent in einem kurzlebigen Container statt direkt auf dem Rechner. Der Schalter ist standardmässig aus, daher ändert sich für bestehende Projekte nichts, solange du ihn nicht einschaltest.

> **Printscreens:** keine. In dieser Sitzung wurde die App nicht gestartet und es gab keinen Browser-Lauf. Die Beschreibung stammt aus dem Quelltext des Auftrags-Branches (`src/core/sandbox.ts`, `src/runner/runner-agent.ts`, `src/runner/runner-cli.ts`, `frontend/src/app/features/settings/settings.component.html`) und aus `docs/agents-und-rechte.md` und `docs/installation.md` desselben Branches. Abschnitt 10 nennt die Aufnahmen, die noch fehlen.
>
> **Stand:** Der Code liegt auf dem Branch `auftrag/ef52246b-docker-sandbox-phase-1-entwickle`. Das Image `aideation-agent` wurde auf dem Entwicklungsrechner noch nicht gebaut, und der Docker-Integrationstest ist nicht gelaufen. Die Angaben zu Verhalten im Container sind daher aus dem Code abgeleitet und noch nicht im Lauf geprüft.

---

## 1. Was die Sandbox ist

Der Entwickler-Agent schreibt und ändert Code. Bisher lief er mit den Rechten des Worker-Benutzers auf dem Rechner. Die einzige Grenze waren die Regeln des Wächters (Befehlsprüfung und Pfadprüfung). Mit der Sandbox läuft der Entwickler in einem Docker-Container. Der Container sieht nur den Arbeitsordner des Auftrags. Das Verhalten ist auf macOS, Linux und Windows gleich.

Der Worker bleibt auf dem Rechner. Er startet den Container, nimmt die Ausgabe entgegen, legt Commits auf den Auftrags-Branch und steuert den Lauf.

**Wichtig:** In dieser Phase nutzt nur die Rolle **Entwickler** die Sandbox. Alle anderen Rollen (Tester, Auftragsautor, Dokumentierer, Wächter usw.) laufen weiter direkt auf dem Rechner.

## 2. Einschalten

Der Schalter heisst `DEV_LOG_AGENT_SANDBOX` und hat zwei Werte:

| Wert | Wirkung |
|---|---|
| `off` (Standard) | Der Entwickler läuft direkt auf dem Rechner wie bisher. |
| `docker` | Der Entwickler läuft im Container aus dem Image `aideation-agent`. |

Der Schalter gibt es an zwei Stellen:

- **Global** als `DEV_LOG_AGENT_SANDBOX=docker` in `worker.env`. Danach den Worker neu starten.
- **Je Projekt** unter **Einstellungen → Projekt & Ordner → „Docker-Sandbox für den Entwickler“**. Zur Auswahl stehen:
  - „Wie global (DEV_LOG_AGENT_SANDBOX, Standard aus)“: Der Projektwert ist leer, der globale Schalter gilt.
  - „Aus – der Entwickler läuft direkt auf dem Rechner“
  - „Docker – der Entwickler läuft im Container „aideation-agent““

**Der Projektwert geht vor.** Ein Projekt mit „Aus“ bleibt also auf dem Rechner, auch wenn global `docker` gesetzt ist. Ein Projekt mit „Docker“ nutzt die Sandbox, auch wenn global `off` gilt.

Unbekannte Werte in `worker.env` gelten als nicht gesetzt, also als `off`.

## 3. Einrichtung (einmalig)

Die Einrichtung ist unter `docs/installation.md` (Abschnitt „Docker-Sandbox für Agents (optional)“) ausführlich beschrieben. Kurz:

1. **Image bauen**, im AIdeation-Ordner:
   ```
   docker build -t aideation-agent -f deploy/agent/Dockerfile .
   ```
   Das passiert auch bei jedem „AIdeation neu starten“ und im CI-Job `docker`. Das Image enthält Playwright mit Browsern, Node 22, die Claude-CLI in fester Version, Git, ripgrep und den Wächter.
2. **Anmeldung für die Claude-CLI.** Im Container gibt es kein `~/.claude` des Rechners. Du brauchst also einen eigenen Wert:
   - `claude setup-token` ausführen und den Wert als `CLAUDE_CODE_OAUTH_TOKEN=…` in `worker.env` eintragen.
   - Alternativ `ANTHROPIC_API_KEY`.
3. **Schalter setzen** (global oder je Projekt, siehe Abschnitt 2).
4. **Worker neu starten.**

Optional kannst du den Container begrenzen:

| Variable | Standard | Wirkung |
|---|---|---|
| `DEV_LOG_AGENT_SANDBOX_CPUS` | `2` | Anzahl CPUs je Container |
| `DEV_LOG_AGENT_SANDBOX_MEMORY` | `4g` | Speicherlimit je Container |

## 4. Was der Container sieht und was nicht

Eingebunden sind nur diese Dinge:

- **Der Worktree des Auftrags** als `/workspace` (lesen und schreiben). Der Agent arbeitet dort.
- **`node_modules` als Volume** je Projekt, Name `aideation-node-modules-<projekt>`. Das Volume enthält Linux-Binärdateien, deshalb nicht die des Rechners.
- **`.dev-log-backups/`** liegt wie bisher im Worktree.

Nicht eingebunden sind:

- Der Docker-Socket.
- Das Home-Verzeichnis, `~/.ssh` und `~/.claude` des Rechners.
- Die `.env`-Datei des Rechners.
- Der Git-Ordner des Hauptprojekts (siehe Abschnitt 6).

Der **Wächter bleibt aktiv** im Container. Das Image enthält ihn gebündelt, und die Befehlsprüfung gilt wie bisher für alle Befehle des Agents.

Die Log-Ordner des Worker-Benutzers werden im Container nicht freigegeben. Die Anmeldung wird nie in Logs oder in Befehlszeilen geschrieben.

**Ollama (lokales Modell):** Im Container zeigt `DEV_LOG_OLLAMA_URL` auf `http://host.docker.internal:11434`. Unter Linux wird dafür automatisch `host.docker.internal:host-gateway` gesetzt. Die Shell-Befehle des lokalen Modells laufen im Container. Seine Datei-Werkzeuge laufen weiterhin vom Worker aus im Worktree.

## 5. Ablauf eines Laufs

1. Der Worker prüft vor dem Start, ob Docker erreichbar ist, das Image vorhanden ist und die Anmeldung gesetzt ist.
2. Er bereitet das `node_modules`-Volume vor. Das Volume gehört dem Container-Benutzer, damit der Agent ohne root arbeiten kann.
3. Er startet den Container mit `docker run --rm` und dem Label `aideation.run=<Lauf-ID>`.
4. Die Ausgabe läuft wie bei einem Lauf auf dem Rechner ins Auftrags-Log. Sie wird vorher maskiert.
5. Nach dem Ende kommt das Ergebnis wie bisher auf den Auftrags-Branch. Commits macht der Worker.

### 5.1 Abbruch und Zeitlimit

- **Abbruch** (über die Abbrechen-Funktion des Laufs) und **Zeitlimit** beenden den **Container** (`docker kill`), nicht nur den Client. Der Abbruch soll innerhalb von 10 Sekunden wirken.
- Nach jedem Ende, auch bei Fehlern, wird der Container sicher entfernt (`docker rm -f`). Die Sperre des Auftrags wird danach freigegeben.
- **Aufräumen beim Start:** Startet der Worker neu, entfernt er übrig gebliebene Container mit dem Label `aideation.run`. Mit `docker ps --filter label=aideation.run` siehst du laufende Sandbox-Container.

## 6. Bedingungen und Grenzen

| Bedingung | Was passiert |
|---|---|
| Schalter aus (`off`) | Der Entwickler läuft wie bisher auf dem Rechner. |
| Schalter `docker`, Docker läuft, Image vorhanden, Anmeldung gesetzt | Der Entwickler läuft im Container. |
| Schalter `docker`, Docker nicht erreichbar | Der Schritt scheitert mit einer Meldung. Er läuft **nicht** auf dem Rechner. |
| Schalter `docker`, Image `aideation-agent` fehlt | Der Schritt scheitert mit der Meldung „Image „aideation-agent“ fehlt“. Er läuft **nicht** auf dem Rechner. |
| Schalter `docker`, Anmeldung fehlt | Der Schritt scheitert mit der Meldung „Anmeldung der Claude-CLI fehlt“. Er läuft **nicht** auf dem Rechner. |
| Schalter `docker`, Rolle ist nicht Entwickler | Die Sandbox gilt nicht. Die Rolle läuft auf dem Rechner. |

**Fail-closed heisst:** Fehlt Docker, das Image oder die Anmeldung, wird der Lauf blockiert. Es gibt keinen stillen Ausweg auf den Rechner.

**Git im Container:** Der Git-Ordner des Hauptprojekts ist nicht eingebunden. `git status` und `git diff` funktionieren im Container daher nicht. Commits und der Auftrags-Branch macht weiterhin der Worker auf dem Rechner.

**Fortgesetzte Sitzung:** Eine fortgesetzte Claude-Sitzung (`--resume`) gibt es im Container nicht. Der Schritt startet frisch.

**Erster Lauf:** Das `node_modules`-Volume ist leer. Vor dem Lauf füllt der Worker es in einem eigenen Container mit `npm ci --ignore-scripts`. Dieser Container sieht nur `package.json`, das Lockfile und `.npmrc`. Der erste Lauf dauert deshalb länger. Danach wird nur neu installiert, wenn sich `package-lock.json` ändert (Stempel `.aideation-lock` im Volume). Zurücksetzen mit `docker volume rm aideation-node-modules-<projekt>`.

## 7. Meldungen

Die Meldungen erscheinen im Auftrag und im Worker-Badge. Sie sind so formuliert, dass du weisst, was zu tun ist.

| Meldung | Ursache | Was du tust |
|---|---|---|
| „Sandbox (DEV_LOG_AGENT_SANDBOX=docker): Docker ist nicht erreichbar – der Agent wurde nicht gestartet, auch nicht auf dem Host. Docker starten oder die Sandbox ausschalten.“ | Docker läuft nicht. | Docker Desktop oder den Docker-Dienst starten, oder den Schalter auf `off` setzen. |
| „Sandbox (DEV_LOG_AGENT_SANDBOX=docker): Image „aideation-agent“ fehlt – der Agent wurde nicht gestartet, auch nicht auf dem Host.“ | Das Image ist nicht gebaut. | `docker build -t aideation-agent -f deploy/agent/Dockerfile .` ausführen. |
| „Sandbox: Anmeldung der Claude-CLI fehlt – im Container gibt es kein ~/.claude des Hosts. CLAUDE_CODE_OAUTH_TOKEN (aus „claude setup-token“) in worker.env eintragen und den Worker neu starten.“ | `CLAUDE_CODE_OAUTH_TOKEN` fehlt. | Token mit `claude setup-token` erzeugen, in `worker.env` eintragen, Worker neu starten. |
| „Hinweis: Die Claude-CLI hat ein Nutzungslimit gemeldet – kein Fehler der Sandbox.“ | Das Monatslimit der Claude-CLI ist erreicht. | Nichts an der Sandbox ändern. Das Limit abwarten oder erhöhen. |
| „Hinweis: Die Claude-CLI im Container ist nicht angemeldet – CLAUDE_CODE_OAUTH_TOKEN in worker.env prüfen.“ | Die Anmeldung wird abgelehnt. | Token in `worker.env` prüfen und ggf. erneuern. |
| „Sandbox: Docker konnte den Container nicht starten (Exit-Code 125).“ | Docker-Fehler beim Start. | Docker-Zustand prüfen. Die Meldung zeigt den Docker-Fehlertext. |
| „Sandbox: node_modules-Volume „…“ liess sich nicht vorbereiten … Der Agent wurde nicht gestartet.“ | Das Volume konnte nicht angelegt werden. | Die angezeigte Ausgabe prüfen. Ggf. `docker volume rm` und neu versuchen. |
| „Sandbox: npm ci im node_modules-Volume „…“ ist fehlgeschlagen … Der Agent wurde nicht gestartet.“ | Die Abhängigkeiten liessen sich nicht installieren, etwa weil das Lockfile nicht passt oder die npm-Registry nicht erreichbar ist. | Die angezeigte npm-Ausgabe prüfen. Danach `docker volume rm aideation-node-modules-<projekt>` und neu versuchen. |

**Limit-Meldungen sind kein Sandbox-Fehler.** Die Meldung „monthly spend limit“ der Claude-CLI wird als Hinweis gekennzeichnet. Du musst dann nicht an der Sandbox suchen.

## 8. Fehlerbehebung

- **Der Entwickler läuft nicht im Container, obwohl der Schalter auf `docker` steht.** Prüfe, ob im Projekt „Wie global“ gewählt ist und der globale Wert stimmt. Ein Projekt mit „Aus“ hat Vorrang. Danach den Worker neu starten.
- **`docker ps --filter label=aideation.run` zeigt nichts, obwohl ein Lauf läuft.** Prüfe, ob der Schalter tatsächlich für dieses Projekt gilt. Läuft der Lauf auf dem Rechner, erscheint kein Container.
- **Der Abbruch wirkt nicht sofort.** Der Abbruch soll den Container innerhalb von 10 Sekunden beenden. Bleibt er länger aktiv, prüfe `docker ps --filter label=aideation.run` und entferne den Container von Hand mit `docker rm -f <Name>`. Beim nächsten Start des Workers wird er ohnehin entfernt.
- **Der erste Lauf dauert lange.** Das ist beim leeren `node_modules`-Volume normal (`npm ci`).
- **`tsc: not found` / `tsx: not found` (Exit-Code 127) im Container.** Meist hängt das Volume nicht dort, wo `/workspace/node_modules` hinzeigt. Läuft der Worker mit altem Code, ist `node_modules` im Worktree noch ein Symlink auf den Hauptordner. Dann den Worker neu starten (ab 30.10.2026 ersetzt er den Link vor jedem Lauf). Gibt es den Stempel `.aideation-lock` im Volume nicht, wurde es nie gefüllt.
- **Das Verhalten ist beim Git-Befehl im Agent anders.** Git im Container funktioniert nicht (Abschnitt 6). Das ist in Phase 1 so vorgesehen.

## 9. Noch offen (für Entwickler)

- Das Image `aideation-agent` ist noch nicht gebaut. Vor dem produktiven Einsatz bitte ausführen:
  - `docker build -t aideation-agent -f deploy/agent/Dockerfile .`
  - `DEV_LOG_TEST_REQUIRE_DOCKER=1 npx --no-install tsx --test src/core/sandbox-docker.test.ts`
- Das Einbinden über den Symlink im Worktree funktionierte nicht. Im Container zeigte der Link auf einen leeren Ordner (`tsc: not found`, Exit-Code 127). Seit dem 30.10.2026 ersetzt der Worker vor dem Lauf den `node_modules`-Symlink des Agent-Worktrees durch einen leeren Ordner. Daran hängt das Volume (`prepareModulesMountpoint` in `src/core/sandbox.ts`). Das gilt nur für Git-Worktrees. Projektordner der Menschen bleiben unberührt. Im Host-Modus legt der Worker den Link beim Start wieder an. Mit echtem Docker ist das noch zu prüfen: Image neu bauen, Worker neu starten, `npm run test:unit` im Container.
- Die Anmeldung steht als Wert in der Umgebung des Docker-Clients. Ob das für den Betrieb genügt, ist eine Entscheidung für den Betreiber.
- Phase 2 bis 4 des Konzepts erweitern die Sandbox auf weitere Rollen. Dann sind Wächter, Mounts und Git-Zugriff je Rolle neu zu bewerten.

## 10. Printscreens, die noch fehlen

Für ein vollständiges Handbuch sollten diese Aufnahmen entstehen (mit laufender App und Docker):

1. **Einstellungen → Projekt & Ordner:** das Auswahlfeld „Docker-Sandbox für den Entwickler“ mit den drei Optionen.
2. **Worker-Badge** bei fehlendem Image (Meldung aus Abschnitt 7).
3. **Terminal:** Ausgabe von `docker ps --filter label=aideation.run` während eines Entwickler-Laufs.

---

*Quelle: Auftrag ef52246b, Branch `auftrag/ef52246b-docker-sandbox-phase-1-entwickle`. Nicht committet.*
