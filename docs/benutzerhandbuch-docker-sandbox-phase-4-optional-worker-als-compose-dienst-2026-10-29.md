# Benutzerhandbuch: Worker als Compose-Dienst (Docker-Sandbox Phase 4, optional)

Dieses Kapitel beschreibt Auftrag 8566b14a. Der Worker, der die Aufträge abarbeitet, kann jetzt als Dienst in `docker-compose.yml` laufen. Auf macOS, Linux und Windows braucht die Installation dann nur Docker. `./start.sh` (macOS, Linux) bzw. `start.cmd` (Windows) startet AIdeation samt Worker und Ausfall-Wächter. launchd, systemd und `scripts\run-with-env.ps1` braucht der Worker im Container nicht mehr.

> **Printscreens:** keine. Die App lief in dieser Sitzung nicht, und Docker-Befehle waren nicht freigegeben. Die Beschreibung stammt aus dem Quelltext des Auftrags-Branches (`docker-compose.yml`, `start.sh`, `start.cmd`, `scripts/start.ps1`, `scripts/worker-compose.ts`, `scripts/setup/wizard.html`, `deploy/worker/entrypoint.sh`, `src/runner/system-restart.ts`) und aus `docs/installation.md` und `README.md`. Abschnitt 12 nennt die Aufnahmen, die noch fehlen.
>
> **Stand:** Der Code liegt auf dem Branch `auftrag/8566b14a-docker-sandbox-phase-4-optional-` (Commit b303949, Entwickler). Der Image-Build, der neue CI-Schritt und die manuelle Abnahme unter Linux und Windows sind **nicht geprüft**. Auch `npm test` hat dieses Kapitel nicht ausgeführt.

---

## 1. Was sich ändert

Bisher musste der Worker auf dem Host eingerichtet werden: launchd unter macOS, systemd unter Linux, eine Aufgabe unter Windows. Jetzt gibt es zwei Wege:

- **Worker im Container (neuer Standard):** Der Worker ist ein Dienst von `docker compose`. Du brauchst nur Docker. Der Einrichtungs-Assistent wählt diesen Weg vor.
- **Worker auf dem Host (Alternative):** Die bisherigen Installationsskripte `install-worker.sh`, `install-worker-linux.sh` und `install-worker.ps1` bleiben unverändert. Sie sind weiter für den Betrieb auf dem Host gedacht.

**Nie beide Wege gleichzeitig.** Laufen zwei Worker, beendet sich der zweite wegen der Datenbank-Sperre, meldet das aber bei jedem Neustart.

## 2. Der Einrichtungs-Assistent

Beim ersten Start (oder mit `./start.sh --setup` bzw. `start.cmd --setup`) öffnet sich der Assistent im Browser. Im Schritt „Zugriff, Worker und Beispieldaten“ steht unter **Worker** eine Auswahl:

| Auswahl | Wirkung |
|---|---|
| **Worker im Container (empfohlen)** | Standard. Der Worker läuft als Dienst `worker` mit `docker compose`. Es ist nichts weiter zu installieren. |
| Worker auf diesem Rechner, automatisch beim Anmelden | Installiert den Host-Worker (launchd, systemd bzw. Aufgabenplanung). |
| Später von Hand starten | Kein Worker-Dienst. Start mit `npm run worker`. |

Darunter steht das Feld **Claude-Token für die Agents** (optional, Ausgabe von `claude setup-token`). Der Token landet in der `.env` als `CLAUDE_CODE_OAUTH_TOKEN`. Leer lassen behält einen vorhandenen Wert.

Der Assistent setzt bei „Worker im Container“ das Profil `worker` in `COMPOSE_PROFILES` der `.env`. Ohne dieses Profil startet der Worker nicht. Mit einer Domain für den HTTPS-Zugang steht dort `https,worker`.

## 3. Start: `start.sh` bzw. `start.cmd`

Nach der Einrichtung startest du AIdeation mit einem Befehl:

| System | Befehl |
|---|---|
| macOS, Linux | `./start.sh` |
| Windows | `start.cmd` (Doppelklick genügt) |

Der Ablauf ist derselbe:

1. Prüfung: Node.js 22.12 oder neuer, Docker läuft, `docker compose` ist vorhanden. Fehlt etwas, bricht der Start mit einer Meldung ab.
2. Der Start schreibt `docker-compose.override.yml` neu (Abschnitt 5 und 6).
3. `docker compose up -d --build` startet alle Dienste.
4. Der Start wartet, bis die Oberfläche unter `http://localhost:3100` antwortet, und öffnet sie im Browser.

Der erste Start dauert deutlich länger. Der Worker installiert dann seine `node_modules` im Volume (`npm ci`), das dauert einige Minuten.

## 4. Die Dienste

Mit dem Profil `worker` kommen drei Dienste zu den bisherigen hinzu:

| Dienst | Aufgabe | Docker-Socket |
|---|---|---|
| `worker` | Dauer-Worker für alle Projekte. Startet die Agent-Container und baut beim Neustart die Images. | **ja, nur hier** |
| `worker-volumes` | Einmaliger Schritt vor dem Worker: gibt das Volume für `node_modules` dem Worker-Benutzer. Danach beendet er sich. | nein |
| `watchdog` | Ausfall-Wächter. Alle zwei Minuten ein Prüflauf mit denselben Push-Meldungen wie bisher. | nein |

Der Worker läuft nicht als root. Er bekommt die Gruppe des Docker-Sockets, damit er `docker`-Befehle ausführen kann. Die Linux-Capabilities sind ihm entzogen.

## 5. Gleiche Pfade wie auf dem Host

Der Worker gibt Projektpfade an `docker run` weiter. Der Docker-Daemon löst sie aber auf dem **Host** auf. Deshalb sind diese Ordner im Worker unter **demselben Pfad** eingebunden wie auf dem Host:

- der AIdeation-Ordner,
- jeder Ordner aus `DEV_LOG_PROJECT_ROOTS` (Projektbereiche).

Ohne `DEV_LOG_PROJECT_ROOTS` gilt nur der Ordner, in dem AIdeation liegt.

**Windows:** Der Pfad im Worker ist der von Docker Desktop. Aus `C:\Users\du\Projekte` wird `/c/Users/du/Projekte`. Pfade, die du in der Oberfläche einträgst, übersetzt der Worker selbst.

**macOS:** Der Ordner der Projekte muss in Docker Desktop unter **Settings → Resources → File sharing** freigegeben sein (z. B. `/Volumes/…`).

Die Liste der Ordner schreibt `scripts/worker-compose.ts` in `docker-compose.override.yml`. Die Datei wird bei jedem Start neu erzeugt, solange sie in der ersten Zeile die Kennzeichnung `# Erzeugt von AIdeation` trägt. Ein geänderter Projektbereich wirkt also nach dem nächsten Start.

**Eigene Datei:** Legst du selbst eine `docker-compose.override.yml` ohne diese Kennzeichnung an, überschreibt AIdeation sie nie. Sie muss dann den AIdeation-Ordner und die Projektordner selbst einbinden. Die Datei steht in `.gitignore`.

## 6. Git-Zugang: nur im Worker, nur lesend

Der Worker braucht Zugang zu GitHub, um Stände zu holen und zu pushen. Dieser Zugang gilt **nur für den Dienst `worker`**, und jede Einbindung ist schreibgeschützt (`read_only`):

| Auf dem Host | Im Worker | Anderer Pfad per `.env` |
|---|---|---|
| `~/.ssh` | `/home/worker/.ssh` | `DEV_LOG_WORKER_SSH_DIR` |
| `~/.config/gh` | `/home/worker/.config/gh` | `DEV_LOG_WORKER_GH_CONFIG_DIR` |
| `~/.gitconfig` | `/home/worker/.gitconfig` | `DEV_LOG_WORKER_GITCONFIG` |
| `~/.config/aideation/github-token` | `/run/secrets/github_token` (wird als `GH_TOKEN` gesetzt) | `DEV_LOG_WORKER_GITHUB_TOKEN_FILE` |

**Warum eine Token-Datei?** Unter macOS und Windows hält `gh` den Token im Schlüsselbund. Der Container sieht den nicht. Der Assistent legt den Token deshalb einmalig in `~/.config/aideation/github-token` ab (Rechte 600). Von Hand geht das so:

```
gh auth token > ~/.config/aideation/github-token && chmod 600 ~/.config/aideation/github-token
```

**Agent-Container bekommen keinen dieser Zugänge.** Auch keinen Docker-Socket. Sie laufen mit gefilterter Umgebung (siehe [Docker-Sandbox](docs/installation.md)).

## 7. Neustart über „AIdeation neu starten“

Der Button „AIdeation neu starten“ ersetzt die bisherige Neustart-Schleife von launchd und systemd. Im Container läuft er so ab:

1. Der Worker holt den Stand von `origin`.
2. Er baut `node_modules` im Volume neu, wenn das Lockfile neuer ist.
3. `docker compose up -d --build` baut alle Dienste **außer** `worker`, `worker-volumes` und `watchdog` neu. Diese drei werden nicht ersetzt, weil der Worker sich sonst selbst ersetzen würde.
4. Der Worker baut das Agent-Image und das Worker-Image, prüft die Oberfläche (`http://frontend:8080/health`) und beendet sich mit **Exit-Code 75**.
5. Die Restart-Richtlinie `restart: unless-stopped` startet den Worker sofort wieder. Er lädt den neuen Code aus dem eingebundenen AIdeation-Ordner.

Das **Worker-Image** wird dabei nur gebaut, es wirkt erst beim nächsten `./start.sh` bzw. `start.cmd` (oder `docker compose up -d`). Änderungen am Code wirken dagegen sofort.

Liefert Compose keine Dienstliste, bricht der Neustart mit dem Status „fehlgeschlagen“ ab. AIdeation läuft dann unverändert weiter.

## 8. Gesundheit

- **Worker:** `docker compose ps worker` zeigt `healthy`, solange der Worker sein Lebenszeichen in die Datenbank schreibt (die Prüfdatei ist höchstens 120 Sekunden alt). Der Healthcheck hat 15 Minuten Anlaufzeit, weil die erste Installation so lange dauern kann.
- **Wächter:** `healthy`, solange seine Prüfläufe durchlaufen.
- **Worker-Badge** in der Oberfläche: bleibt an das Lebenszeichen in der Datenbank gebunden. Nach „AIdeation neu starten“ soll es wieder grün sein. Das ist noch nicht geprüft (Abschnitt 12).

## 9. Umstieg vom Host-Worker zum Container

Zuerst den alten Host-Worker stoppen, sonst laufen zwei:

| System | Befehl |
|---|---|
| macOS | `launchctl bootout gui/$(id -u)/com.aideation.worker; launchctl bootout gui/$(id -u)/com.aideation.watchdog` |
| Linux | `systemctl --user disable --now aideation-worker.service` |
| Windows | `Unregister-ScheduledTask -TaskName AIdeationWorker -Confirm:$false` |

Danach `./start.sh --setup` bzw. `start.cmd --setup` und „Worker im Container“ wählen. Der Rückweg: im Assistenten „Worker auf diesem Rechner“ wählen. Er entfernt das Profil `worker` aus `COMPOSE_PROFILES` und stoppt die beiden Container.

## 10. Voraussetzungen

- **Docker** (Docker Desktop unter macOS und Windows, Docker Engine mit Compose-Plugin unter Linux).
- **Unter Linux:** dein Benutzer ist in der Gruppe `docker`. Der Assistent trägt deine `uid:gid` und die Gruppe ein (`DEV_LOG_WORKER_USER`, `DEV_LOG_DOCKER_GID`), damit Dateien in den Projektordnern dir gehören. Unter Docker Desktop gilt die Gruppe `0`.
- **Unter macOS:** Projektordner in Docker Desktop freigegeben (Abschnitt 5).
- **Unter Windows:** Docker Desktop läuft, und die Projekte liegen in einem Pfad, den Docker Desktop einbinden darf.

## 11. Fehler und ihre Ursache

| Meldung oder Zustand | Ursache | Abhilfe |
|---|---|---|
| „Docker läuft nicht“ (beim Start) | Docker Desktop oder der Dienst `docker` ist aus | Docker starten, `./start.sh` bzw. `start.cmd` erneut |
| „Docker Compose … fehlt“ | Compose-Plugin fehlt | Docker Desktop aktualisieren bzw. Compose-Plugin installieren |
| „AIdeation antwortet nicht“ | ein Dienst startet nicht | `docker compose logs dev-log` bzw. `docker compose logs worker` lesen |
| Worker-Container endet mit Exit-Code 78 | AIdeation-Ordner nicht eingebunden, die Override-Datei fehlt | Im AIdeation-Ordner `./start.sh` bzw. `start.cmd` ausführen (oder `npx tsx scripts/worker-compose.ts`) |
| Worker wartet beim ersten Start mehrere Minuten | `npm ci` installiert die Abhängigkeiten im Volume | Abwarten, das ist normal. Fortschritt in `docker compose logs -f worker` |
| `docker-compose.override.yml` wird nicht überschrieben | Die Datei trägt nicht die Kennzeichnung in Zeile 1 | Gewollt: eigene Datei bleibt. Ihren Inhalt von Hand prüfen oder die Kennzeichnung entfernen, damit AIdeation sie neu schreibt |
| Zwei Worker laufen | Host-Worker und Container-Worker gleichzeitig | Abschnitt 9 |
| Agent-Schritt meldet einen Mount- oder Pfadfehler unter Windows (Befund noch nicht beobachtet) | Vermutung: Docker Desktop löst den Pfad `/c/…` für den Agent-Container nicht auf. Ungeprüft, siehe Abschnitt 13, Punkt 2 | Den Fehler mit vollständiger Meldung dem Entwickler melden |

## 12. Bedingungen auf einen Blick

| Bedingung | Was passiert |
|---|---|
| `COMPOSE_PROFILES` ohne `worker` | Kein Worker-Container. Der Host-Worker oder ein Start von Hand ist nötig. |
| `COMPOSE_PROFILES` mit `worker` und ein Host-Worker läuft | Zwei Worker. Der zweite scheitert an der Datenbank-Sperre. |
| Override-Datei mit Kennzeichnung in Zeile 1 | Wird bei jedem Start neu geschrieben. |
| Override-Datei ohne Kennzeichnung | Bleibt unverändert, mit Warnung. |
| Nur Dienst `worker` | Hat den Docker-Socket und den Git-Zugang. `watchdog` und `worker-volumes` nicht. |
| Git-Zugang | Nur schreibgeschützt im Worker. Agent-Container bekommen ihn nicht. |
| „AIdeation neu starten“ | Baut ohne Worker und Wächter neu, Worker endet mit Exit-Code 75 und startet neu. |
| Worker-Image geändert | Wirkt erst nach `./start.sh` bzw. `start.cmd` oder `docker compose up -d`. |
| Code geändert | Wirkt nach dem Neustart des Workers, weil der Code im eingebundenen Ordner liegt. |
| Fehlt der AIdeation-Ordner im Container | Exit-Code 78 mit Meldung. |

## 13. Noch offen

1. **Manuelle Abnahme unter frischem Linux und unter Windows mit Docker Desktop:** `./start.sh` bzw. `start.cmd`, ein Testauftrag bis zum Ende, danach „AIdeation neu starten“ mit grünem Worker-Badge. Das Ergebnis fehlt im Auftrag.
2. **Windows-Pfade:** Ob Docker Desktop die `/c/…`-Mounts aus dem Linux-Worker für `docker run` auflöst, ist das größte offene Risiko.
3. **Image-Build und CI-Job `docker`** (mit der Health-Prüfung des Workers): nicht ausgeführt, weil Docker beim Entwickler fehlte.
4. **`git rm` und `git mv` durch Agents** (aus Phase 3): nicht gelöst. Agents mit der Sandbox `docker` können im Hauptprojekt keine Dateien löschen oder umbenennen. Bis dahin: Datei von Hand löschen oder umbenennen und committen.
5. **Restart-Schleife** bei dauerhaften Startfehlern im Worker-Container: nicht getestet.
6. **`@@SERVICES` in Workflow-Läufen** und die Gruppe „Dienst-Logs“ (`~/Library/Logs`) sind noch macOS-spezifisch (aus Phase 2).
7. **Tests:** `npm test`, `npm run typecheck` und `npm run test:e2e` sind für dieses Kapitel nicht gelaufen. `deploy/worker/Dockerfile` ist nicht gebaut.

## 14. Printscreens, die noch fehlen

Für ein vollständiges Handbuch sollten diese Aufnahmen entstehen (mit laufender App und Docker):

1. **Einrichtungs-Assistent, Seite „Optionen“:** Auswahl „Worker im Container (empfohlen)“ mit den beiden Alternativen und dem Feld für den Claude-Token.
2. **Terminal nach `./start.sh`:** die Meldung „AIdeation läuft“.
3. **`docker compose ps`:** die Dienste `worker`, `worker-volumes`, `watchdog` mit Status `healthy`.
4. **Worker-Badge im Normalbetrieb:** grün, ohne Warnung.
5. **Worker-Badge nach „AIdeation neu starten“:** wieder grün.
6. **Worker-Badge bei Fehler:** etwa bei fehlendem Agent-Image.

---

*Quelle: Auftrag 8566b14a, Branch `auftrag/8566b14a-docker-sandbox-phase-4-optional-`, Commit b303949 (Entwickler), `docs/docker-sandbox-phase-4-optional-worker-als-compose-dienst-2026-10-29.md`. Nicht committet.*
