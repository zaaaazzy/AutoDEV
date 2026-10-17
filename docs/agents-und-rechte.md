# Worker, Agents und Rechte

## 1. Der Worker-Prozess

Es gibt **einen** Worker (`npm run worker` = `tsx src/runner/runner-cli.ts --all --watch`). Er läuft auf dem Host, nicht im Docker-Container `dev-log`, und wird per launchd (`com.devlog.worker`, `./scripts/install-worker.sh`) gestartet und bei Absturz neu gestartet. Log: `~/Library/Logs/dev-log-worker.log`.

- Er bedient **alle registrierten Projekte**, jeweils mit dem Projektordner (`projects.repository`) als Arbeitsverzeichnis. Fehlt der Ordner, zeigt das Worker-Badge den Fehler und Chat-Nachrichten werden mit dem Grund beantwortet.
- Er lädt Code nur beim Start. **Nach jeder Code-Änderung muss er neu gestartet werden:**
  `launchctl kickstart -k gui/$(id -u)/com.devlog.worker`
- Alle 15 s sendet er einen Heartbeat (Worker-Badge im Dashboard).
- Gleichzeitig laufen höchstens `maxConcurrentAgents` Projekte (Einstellung, Standard 2). Das Projekt, das am längsten wartet, kommt zuerst.

## 2. Automatische Trigger

| Trigger                                      | Takt                                 | Was passiert                                                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat-Nachricht im Dashboard                  | alle 1,5 s, unabhängig von Aufträgen | Assistent beantwortet die älteste offene Nachricht (`processChat`); danach wird eine angeforderte Problemanalyse bearbeitet (`analyzeBlocked`).                                                                        |
| Arbeitszyklus pro Projekt                    | alle 30 s (`--interval`)             | `runWorkflow`: Ideen schätzen → Ideen zu Aufträgen ausarbeiten → Sprint mit Git synchronisieren → Aufträge abarbeiten → Repo-Doku spiegeln → Sprint-Bericht → Git-Sync.                                                |
| Auftrag ausführbar                           | im Arbeitszyklus                     | Status `planned` und (Sprint aktiv **oder** fester Agent gesetzt **oder** `auto_run`). Backlog-Aufträge im aktiven Sprint werden automatisch auf `planned` gesetzt. Reihenfolge: Priorität hoch → niedrig, dann Alter. |
| Idee mit Status `requested`                  | im Arbeitszyklus                     | Auftragsautor schreibt daraus einen Backlog-Auftrag (Sprint-Zuordnung bleibt manuell). Hängende `drafting`-Ideen werden nach einer Frist zurückgesetzt.                                                                |
| Ideen ohne Schätzung                         | im Arbeitszyklus                     | Aufwand, Tokens, Nutzen, Kosten werden geschätzt.                                                                                                                                                                      |
| Analyse blockierter Aufträge                 | über den Chat-Takt                   | Wenn `analysis_status = requested`, analysiert der Assistent Fehlerausgaben und bekannte Bugs.                                                                                                                         |
| Start des Workers                            | einmalig                             | Unterbrochene Läufe werden wiederhergestellt; Läufe, die älter als 3 h im Status `running` sind, werden als fehlgeschlagen markiert.                                                                                   |
| Herunterfahren                               | Signal                               | Laufende Chat-Anfragen gehen zurück auf `pending`.                                                                                                                                                                     |
| Dashboard-Seite öffnen / Tab wieder sichtbar | Browser                              | Daten laden automatisch; zusätzlich Polling (Worker 10 s, laufende Runs 3 s).                                                                                                                                          |

Pro Auftrag läuft immer nur **ein** Lauf (`agent_runs` mit Status `running` ist eindeutig).

## 3. Workflow-Agents (pro Projekt konfigurierbar)

Ein Auftrag durchläuft die aktivierten Agents nach Phase und Position: `pre_task` → `while_task` → `after_task`. Jeder Agent kann einen eigenen Befehl (`command`) haben; sonst gilt `DEV_LOG_AGENT_COMMAND`, sonst das lokale Ollama-Modell (`qwen3.5:9b`).

| Agent                  | Rolle                | Phase      | Aufgabe                                                                                                               | Dateien ändern                            | Befehle                                   |
| ---------------------- | -------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------- |
| Auftragsautor          | `author`             | pre_task   | Auftrag beschreiben (Ziel, Kriterien, Dateien, Diagramme). Wird übersprungen, wenn der Auftrag aus einer Idee stammt. | nein                                      | nein                                      |
| Bug-Wächter            | `bug_reviewer`       | pre_task   | Bekannte Bugs prüfen → Risiken beim Auftrag. Übersprungen, wenn schon Risiken vorhanden.                              | nein                                      | nein                                      |
| Entwickler             | `developer`          | while_task | Auftrag umsetzen. Bei Bug-Aufträgen wird die Ausgabe als Fix-Notiz am Bug gespeichert.                                | **ja**, mit Backup in `.dev-log-backups/` | npm test/run/install, git status/diff/log |
| Tester                 | `tester`             | after_task | Tests entwickeln, Build/Tests ausführen, Fehler als Bug melden.                                                       | nein                                      | nein (Testbefehle führt der Runner aus)   |
| Dokumentierer          | `documenter`         | after_task | Ergebnis dokumentieren → Auftragsdoku.                                                                                | nein                                      | nein                                      |
| Handbuch-Autor         | `manual_writer`      | after_task | Technisches Handbuch pflegen.                                                                                         | nein                                      | nein                                      |
| Benutzerhandbuch-Autor | `user_manual_writer` | after_task | Benutzerhandbuch pflegen.                                                                                             | nein                                      | nein                                      |
| eigene                 | `custom`             | frei       | Beliebige Zusatzrolle.                                                                                                | nein                                      | nein                                      |

Ohne Schreibrecht erhalten Agents nur Lese-Werkzeuge (Verzeichnis, Datei lesen, Suche) mit etwa 25 Werkzeugschritten; der Entwickler hat bis zu 80 Schritte.

## 4. Der Dashboard-Assistent (Problemlöser)

Der Assistent ist **kein** Workflow-Agent, sondern bedient den Chat und die Problemanalyse. Er führt Anfragen **selbst** aus, erstellt keine Aufträge und delegiert nicht; Fortschritt wird live im Chat gemeldet.

Er hat höhere Rechte als alle anderen, bleibt aber im Projektordner:

- **Lesen/Schreiben:** `read_file`, `list_files`, `search`, `write_file`, `replace_in_file` – nur innerhalb des Projektordners (Backups in `.dev-log-backups/`).
- **Datenbank:** `run_sql` (Entwickler und Assistent) – lesen und schreiben in der Projekt-Datenbank (`projects.database_url`, in den Einstellungen gepflegt, wird nie ans Frontend ausgegeben). Eine Transaktion, 15 s Limit, max. 50 Zeilen; `UPDATE`/`DELETE` nur mit `WHERE`; gesperrt: DROP/ALTER/CREATE DATABASE/ROLE/EXTENSION, GRANT/REVOKE, COPY, Rollenwechsel, Server-Funktionen. Die Dev-Log-Datenbank selbst wird abgelehnt.
- **Schleifenschutz:** Wiederholt ein Modell denselben Absatz (3×) oder denselben Werkzeugaufruf (4× in Folge), bricht der Lauf ab.
- **Git:** `status`, `diff`, `log`, `show`, `branch`, `remote -v`, `ls-files`, `pull --ff-only`, `fetch`, `checkout <branch>`, `clone <https/ssh-URL> [Unterordner|.]`.
- **npm/node:** `npm test`, `npm run <skript>`, `npm install|ci [Pakete]`, `npm ls|outdated|audit`, `node --version`, tsc/eslint/prettier/jest/vitest.
- **Docker Compose** (im Projektordner): `ps`, `config --services`, `logs`, `up -d [--build|--wait|--force-recreate] [Dienste]`, `stop`, `start`, `restart`, `down [--remove-orphans]`, `build`, `pull`.

**Compose-Schutz:** Vor `up`, `start`, `restart` und `build` prüft der Worker `docker compose config`. Abgelehnt werden privilegierte Dienste, Host-Namensräume (`network_mode/pid/ipc: host`), `cap_add`, `devices`, Bind-Mounts und Build-Kontexte außerhalb des Projektordners (z. B. `docker.sock`).

**Projektsperre:** Befehle (git, npm, docker) des Assistenten, der Agents und des Git-Syncs laufen pro Projektordner nacheinander, nie gleichzeitig. Dateischreibzugriffe sind davon nicht betroffen.

**Tester:** Testbefehle laufen mit dem Zeitlimit des Workers, ohne `DEV_LOG_*`-Variablen, und lassen sich über „Abbrechen“ stoppen. Der Worker überschreibt dabei nie den gespeicherten Projektordner.

**Projektordner:** Müssen absolut, ohne `..` und spezifisch sein (nicht `/`, `/Users`, `/Users/<name>`, `/Volumes/<Datenträger>`, Systemordner). Mit `DEV_LOG_PROJECT_ROOTS` lassen sie sich zusätzlich auf feste Wurzeln beschränken.

**Problemanalyse:** Läuft mit der Rolle `analyst` – nur Lesen, keine Befehle, keine Schreibrechte.

**Nicht erlaubt (für alle Agents):** Dateien außerhalb des Projektordners, `.env`, Schlüssel, `.git`, `node_modules`, Backup-Ordner, Symlink-Ausbrüche, `docker run`, `docker compose down -v`, `git push`, `rm`, verkettete Befehle (`;`, `&&`, Pipes – Befehle laufen ohne Shell), `git clone` mit `file://`, Optionen oder Zielen außerhalb des Projekts.

Zusätzlich gilt: Ist `DEV_LOG_AGENT_COMMAND` oder ein eigener Agent-Befehl gesetzt, läuft dieser statt des lokalen Modells und die obigen Werkzeugregeln greifen dafür nicht.

## 5. Weitere Hintergrundaufgaben (ohne eigenes Modell)

- **Git-Sync:** committet den Arbeitsstand mit dem Sprintnamen, setzt einen Tag und pusht, wenn das Projekt eine Repository-URL hat.
- **Repo-Doku-Sync:** spiegelt `README.md` und `docs/*.md` ins Dashboard.
- **Sprint-Bericht:** wird nach jedem Zyklus für den aktiven Sprint erzeugt.
- **Test-Agent** (`test-agent.ts`): führt konfigurierte Testbefehle aus und protokolliert Läufe und Schritte.

## System-Agents und ihre Modelle

Dashboard-Assistent, Problemanalyse und Schnellschätzung laufen lokal über Ollama. Im Bereich „Agents“ wählst du ihr Modell aus den installierten Ollama-Modellen. Die Wahl wird in `app_settings` (`model:<rolle>`) gespeichert, der Worker übernimmt sie innerhalb von 15 Sekunden und sie hat Vorrang vor `DEV_LOG_OLLAMA_MODEL_<ROLLE>`.
