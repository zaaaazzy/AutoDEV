# AIdeation installieren

AIdeation besteht aus drei Teilen:

| Teil | Läuft | Aufgabe |
|---|---|---|
| **AIdeation** (Oberfläche + API) | in Docker | Projekte, Ideen, Aufträge, Sprints, Dokumentation |
| **Datenbank** (PostgreSQL) + Backups (etwa täglich) | in Docker | alle Daten, Backups unter `backups/` |
| **Worker** | direkt auf deinem Rechner | startet die Agents in deinen Projektordnern |

## Voraussetzungen

- **Docker Desktop** (macOS, Windows) bzw. Docker Engine mit Compose (Linux) – läuft beim Start.
- **Node.js 22.12** oder neuer (mit npm) – für Worker, Einrichtung und die Projektvorlagen (Vite 8, Angular 20).
- **Git**.
- Mindestens ein KI-Werkzeug für die Agents:
  - **Claude Code** (`claude`) – beste Ergebnisse, Anmeldung über dein Claude-Konto, oder
  - **Ollama** – kostenlos und lokal (z. B. `ollama pull qwen3.5:9b`).

## 1. Herunterladen

```bash
git clone <repository-url> AIdeation/source
cd AIdeation/source
```

## 2. Starten

| System | Befehl |
|---|---|
| macOS / Linux | `./start.sh` |
| Windows | Doppelklick auf `start.cmd` |

Beim **ersten Start** installiert das Skript die Abhängigkeiten und öffnet den **Einrichtungs-Assistenten** im Browser:

1. **System** – prüft Node, Docker, Git, Claude Code, Ollama und Chromium für Playwright.
2. **Zugang** – Benutzername und Passwort des Systemadministrators (ein sicheres Passwort wird vorgeschlagen).
3. **Optionen** – eigene Domain für HTTPS von unterwegs (optional), erlaubte Projektordner, Worker-Autostart.
4. **Installation** – schreibt die `.env`, baut und startet die Container, richtet den Worker ein
   (macOS: launchd, Linux: systemd-Benutzerdienst, Windows: Aufgabenplanung). Dazu lädt sie die
   **Spiele-Werkzeuge**: Chromium für Playwright (falls er fehlt) und die npm-Pakete der Phaser-Vorlage in den
   npm-Cache. Schlägt das fehl (z. B. offline), läuft AIdeation trotzdem; das Protokoll nennt den Befehl zum
   Nachholen. Das Protokoll läuft live mit.

Danach öffnet sich AIdeation unter `http://localhost:3100`. Nach der Anmeldung begrüßt dich AIdeation und bietet an,
das erste Projekt anzulegen.

Bei **späteren Starts** startet `./start.sh` bzw. `start.cmd` nur die Dienste und öffnet AIdeation. Vorher prüft es,
ob Chromium für Playwright da ist, und lädt ihn sonst nach (ist er da, dauert das nur Sekunden).
Mit `./start.sh --setup` (Windows: `start.cmd --setup`) öffnest du den Assistenten erneut. Die bisherige `.env`
wird vorher als `.env.bak-<Zeit>` gesichert und dann **ergänzt, nicht ersetzt**:

- Gesetzt werden nur Benutzername, Passwort und die ausgefüllten Optionen. Leere Felder (Domain, Projektbereich)
  lassen bestehende Werte stehen. Eigene Einträge, Kommentare und die Reihenfolge bleiben erhalten.
- **Secret Key** (`DEV_LOG_SECRET_KEY`): Fehlt er oder ist er leer, erzeugt der Assistent einen zufälligen Schlüssel.
  Ein vorhandener Schlüssel wird nie ersetzt. Mit ihm werden die Zugangsdaten der Projekte und die Schlüssel der
  Zwei-Faktor-Anmeldung verschlüsselt. Ohne ihn lässt sich kein zweiter Faktor einrichten. Sind schon Zwei-Faktor-
  Schlüssel gespeichert, startet der Dienst ohne ihn (oder mit einem anderen Schlüssel) nicht. Ältere, unverschlüsselt
  gespeicherte Zwei-Faktor-Schlüssel verschlüsselt der Dienst beim ersten Start mit dem Schlüssel.
  **Sichere die `.env` (oder wenigstens diesen Schlüssel) in deinem Passwort-Manager.** Geht er verloren, sind die
  verschlüsselten Werte nicht mehr lesbar.
- **Datenbank-Passwort** (`DEV_LOG_DB_PASSWORD`): Fehlt es, wird ein zufälliges erzeugt (früher galt der Standard
  `devlog_local_dev`). Weil Postgres das Passwort nur beim ersten Anlegen übernimmt, setzt der Assistent es in einer
  schon vorhandenen Datenbank per `ALTER USER`, bevor die übrigen Container starten.
- Die `.env` und ihre Sicherungen sind nur für dich lesbar (Modus `600`) und stehen in `.gitignore`.
- Der Worker bekommt den Secret Key mit (macOS: LaunchAgent, Linux: systemd-Dienst, Windows: Startdatei
  `%LOCALAPPDATA%\AIdeation\worker.cmd` der Aufgabe `AIdeationWorker`).
- Läuft die Einrichtung schon in einem anderen Fenster, lehnt der Assistent einen zweiten Start ab. Nach einem
  Fehler bleibt er offen, ein neuer Versuch ist mit „Zurück“ möglich.

## 3. Erstes Projekt und Tour

1. **Projekt erstellen** – der Projekt-Assistent prüft den Ordner, richtet Git/GitHub und auf Wunsch eine Vorlage ein,
   testet die Agent-Verbindung und legt die Rechte der Agents fest.
2. **Tour starten** – danach (oder jederzeit unter **Hilfe → Interaktive Tour**) führt dich AIdeation Schritt für Schritt:
   - **Ideation**: Idee erfassen, Auftrag vom Auftragsautor erstellen lassen
   - **Auftrag**: Aufträge direkt anlegen, „In Entstehung“ und „Besondere Aufmerksamkeit“
   - **Sprint**: Sprint anlegen, unter **Aufträge hinzufügen** offene Aufträge in den Sprint nehmen –
     die Reihenfolge unter „Geplant“ (↑/↓) bestimmt, was die Agents zuerst abarbeiten
   - **Sprint starten** und dem ersten Agent live zuschauen

Ausprobierte Projekte lassen sich unter **Einstellungen → Projekt löschen** wieder entfernen – auf Wunsch samt
Ordner auf deinem Rechner.

## Browser-Spiele mit Phaser

Im Projekt-Assistenten steht unter **Vorlage** die Karte **Browser-Spiel (Phaser 3)**: Vite, TypeScript, Phaser 3,
eine Beispielszene („Sterne sammeln“), Unit-Tests der Spiellogik mit Vitest und ein Playwright-Smoke-Test, der prüft,
dass der Canvas zeichnet und keine Konsolenfehler auftreten. Die Dateien liegen in `templates/phaser-game/`. Phaser
kommt als Abhängigkeit ins Spielprojekt, nicht in AIdeation. Die Vorlage installiert die Pakete
(`npm install --ignore-scripts`) und Chromium in der Playwright-Version von AIdeation. Ist Chromium schon da, entfällt
der Download.

Alle Vorlagen mit Befehlen laufen ohne Install-Skripte fremder Pakete: Jede Installation hat `--ignore-scripts`, und der
Worker setzt zusätzlich `npm_config_ignore_scripts=true`. Generatoren, die sonst selbst installieren (Angular CLI,
create-next-app, NestJS CLI, nuxi), laufen mit `--skip-install` bzw. `--no-install`. Danach folgt ein eigener
`npm install --ignore-scripts`. Die Generator-Versionen sind fest eingetragen (`GENERATORS` in
`src/setup/templates.ts`). Bei Nuxt entfällt dadurch `nuxt prepare` nach der Installation, das holt der erste
`npm run dev` bzw. `npm run build` nach.

Beim Anlegen mit dieser Vorlage belegt AIdeation die Projekt-Einstellungen vor (änderbar unter **Einstellungen**):

| Einstellung | Wert |
|---|---|
| Testbefehle (Live schalten) | `npm run build`, `npm test`, `npm run test:smoke` |
| Testbefehle je Auftrag | `npm run typecheck`, `npx vitest run {tests}`, `npm run test:smoke` |
| Review-Befehl | `npm run review` (baut und liefert im Review-Container auf `REVIEW_FRONTEND_PORT` aus) |
| Vorschau-Adresse (visuelle Prüfung) | `http://localhost:5180` |
| Regeln für die Agents | Spiellogik in `src/logic/` getrennt von den Phaser-Szenen, Tests neben der Logik |

`{tests}` bekommt je Befehl nur die Testdateien, die der Runner auch ausführt. Playwright-Tests (unter `e2e/` oder mit
Import von `@playwright/test`) gehen nur an Befehle mit `playwright`, alle anderen Testdateien an die übrigen Befehle
(Vitest, `tsx --test`, …). Ändert ein Auftrag nur `e2e/smoke.spec.ts`, wird `npx vitest run {tests}` übersprungen statt
mit „No test files found“ rot zu werden. Das gilt auch für bestehende Projekte, ohne Umstellung. `--passWithNoTests` ist
nicht nötig, ein schon von Hand ergänztes Flag schadet aber nicht.

**Version ansehen** in der Sprint-Ansicht startet damit den gewählten Stand des Spiels im Review-Container. Für die
visuelle Prüfung starte im Projektordner einmal `npm run dev`: Der Vite-Dev-Server auf Port 5180 lädt jede Änderung
sofort neu (Hot Reload), die Prüfung zeigt also immer den neuesten Stand. Port 5180 statt des Vite-Standards 5173,
damit das Spiel nicht mit anderen Vite-Projekten kollidiert; ein anderer Port geht mit `GAME_DEV_PORT=<port> npm run dev`
(dann die Vorschau-Adresse in den Einstellungen anpassen). Der Dev-Server lauscht im ganzen Netzwerk: Auf Handy oder Tablet
öffnest du `http://<IP des Rechners>:5180` oder `http://<rechner>.local:5180`. Die Review-Container von „Version
ansehen“ bleiben dagegen bewusst nur auf diesem Rechner erreichbar (`127.0.0.1`), weil sie Code aus Agent-Commits
ausführen.

**Linux:** Fehlen Chromium Systembibliotheken (Smoke-Test bricht mit „missing dependencies“ ab), einmalig
`sudo npx playwright install-deps chromium` ausführen. Liegen die Playwright-Browser an einem eigenen Ort
(`PLAYWRIGHT_BROWSERS_PATH`), übernehmen die Worker-Installationsskripte die Variable in die Env-Datei des Dienstes.

## Zugriff von unterwegs (optional)

Mit eigener Domain im Assistenten startet zusätzlich der Dienst `https` (Caddy) und holt automatisch ein
Let's-Encrypt-Zertifikat. Dafür muss dein Router **Port 443** (TCP) an diesen Rechner weiterleiten und die Domain
auf deine öffentliche IP zeigen. AIdeation ist dann installierbar als App (Handy: „Zum Home-Bildschirm“) und schickt
Push-Nachrichten. Angenommen werden nur Geräte-Endpunkte der Push-Dienste der Browser (FCM, Mozilla, Apple, Windows,
per https ohne eigenen Port); andere Adressen fragt der Server nie an. Ein Gerät gehört dem Benutzer, der es angemeldet
hat; nur er kann es ändern oder abmelden. Beim Abmelden („Abmelden“ in den Einstellungen) wird auch das Push-Abo des
Geräts entfernt.

## Nützliche Befehle

```bash
docker compose ps                 # Zustand der Dienste
docker compose logs -f dev-log    # Protokoll der API (Oberfläche: frontend)
npm run worker                    # Worker im Vordergrund starten (ohne Autostart)
./start.sh --setup                # Einrichtung wiederholen
```

Jedes Projekt liegt in einem eigenen Ordner mit `source` (Code, z. B. mit laufendem Entwicklungsserver) und
`agent` (Arbeitsordner der Agents, Git-Worktree) – AIdeation selbst ebenso: `AIdeation/source` und `AIdeation/agent`.

Die Container heissen `aideation_frontend_angular` (Oberfläche, nginx, leitet `/api` weiter), `aideation_backend_nodejs`
(API), `aideation_database_postgres` (Datenbank), `aideation_backup_postgres` (Sicherung, etwa täglich) und
`aideation_proxy_caddy` (HTTPS, optional). In den Befehlen oben stehen die Dienstnamen (`frontend`, `dev-log`, `db`,
`backup`, `https`); `docker exec` braucht den Containernamen, z. B.
`docker exec -it aideation_database_postgres psql -U devlog aideation`.

Im Agent-Ordner läuft Compose als eigenes Projekt `aideation-agent` (`COMPOSE_PROJECT_NAME`). Container und Volumes
heissen dort `aideation-agent_…` (eigene, leere Datenbank), und es werden keine Host-Ports veröffentlicht – die Ports
5433, 3100, 80 und 443 bleiben dem Live-Stack. Welche Host-Ports ein Projekt bekommt, steht in
`deploy/compose/ports.<Projekt>.yml`; ein anderer Projektname ohne eigene Datei bricht mit einer Fehlermeldung ab.
Die Agent-Datenbank ist beim ersten Start leer und hat mit dem Live-Stack keine gemeinsamen Daten. Bevor du den Live-Stack
neu startest, lohnt sich ein Blick mit `docker compose config` im Quellordner: Dort müssen die Namen `aideation_…` und die
Ports 5433, 3100, 80 und 443 stehen. Ohne `COMPOSE_PROJECT_NAME` in der `.env` ist das der Fall.

Entwickeln ohne Container (`npm run dev`, `npm run dev:ui`) läuft neben dem Live-Stack: Die Dev-API lauscht auf Port
3101, und `ng serve` leitet `/api` und `/health` dorthin weiter (`frontend/proxy.conf.json`). Die Dev-API braucht eine
eigene Datenbank, z. B. `DEV_LOG_DATABASE_URL=postgresql://devlog:<passwort>@127.0.0.1:5433/aideation_dev`; sie wird beim
Start angelegt. Mit `PORT=3100` oder der Live-Datenbank `aideation` bricht `npm run dev` mit einer Meldung ab.

## Hintergrunddienste und Zugänge

Die Installationsskripte (`scripts/install-worker.sh`, `install-watchdog.sh`, `install-worker-linux.sh`,
`install-worker.ps1`) schreiben die Zugänge (`DEV_LOG_DATABASE_URL`, `DEV_LOG_SECRET_KEY`) in eine **Env-Datei, die nur
du lesen kannst**. In Plist, systemd-Unit oder Befehlszeile der geplanten Aufgabe stehen sie nicht mehr. Beim Start liest
`scripts/run-with-env.sh` bzw. `run-with-env.ps1` die Datei. Fehlt sie oder können andere sie lesen, bricht der Start
mit einer Meldung im Log ab.

| System | Dienst | Env-Datei |
|---|---|---|
| macOS | `~/Library/LaunchAgents/com.aideation.worker.plist` (Rechte 600) | `~/.config/aideation/worker.env` (600) |
| macOS | `~/Library/LaunchAgents/com.aideation.watchdog.plist` (600) | `~/.config/aideation/watchdog.env` (600) |
| Linux | `~/.config/systemd/user/aideation-worker.service` (600) | `~/.config/aideation/worker.env` (600) |
| Windows | Aufgabe `AIdeationWorker` | `%LOCALAPPDATA%\AIdeation\worker.env` (ACL nur für dich) |

Werte ändern: Skript mit neuen Werten erneut ausführen, z. B. `DEV_LOG_DATABASE_URL=… ./scripts/install-worker.sh`.
Ohne Angabe übernimmt ein erneuter Lauf die Werte aus der bestehenden Env-Datei.

**Neustart unter Windows:** Nach „AIdeation neu starten“ beendet sich der Worker mit Exit-Code 75. launchd
(KeepAlive) und systemd (`Restart=always`) starten ihn ohnehin neu. Unter Windows startet die Aufgabe nur bei der
Anmeldung, deshalb übernimmt `run-with-env.ps1` den Neustart: Bei Exit-Code 75 wartet das Skript 5 s
(`AIDEATION_RESTART_DELAY_SECONDS`), liest `worker.env` neu ein und startet den Worker wieder. Jeder andere Exit-Code
(bewusster Stopp, echter Fehler) beendet die Aufgabe, ohne neu zu starten. Die Aufgabe hat kein Zeitlimit (vorher galt
der Standard von 72 Stunden). Ältere Installationen: `scripts\install-worker.ps1` einmal erneut ausführen. Kommt der
Worker trotzdem nicht wieder, steht der Status auf „restarting“. Nach 10 Minuten lässt sich dann ein neuer Neustart
anfordern, statt dauerhaft „Ein Neustart läuft bereits“ zu sehen.

**Umstieg von älteren Installationen:** Ältere Skripte schrieben die Zugänge direkt in Plist bzw. Unit (für alle lesbar)
und unter Windows in die Befehlszeile der Aufgabe. Führe das passende Skript einmal erneut aus. Es ersetzt die alte
Plist bzw. Unit, unter Windows die Aufgabe. Danach stehen keine Zugänge mehr darin. Wurde das Datenbank-Passwort früher
in einer Plist oder Unit gespeichert, solltest du es ändern.

**Woher die Skripte den Zugang nehmen:** Die Installationsskripte (`install-worker.sh`, `install-worker-linux.sh`,
`install-watchdog.sh`, `install-worker.ps1`) lesen jeden Wert in dieser Reihenfolge: Umgebung, `.env` der Installation,
bestehende Env-Datei des Dienstes. Ein frisch installierter Dienst übernimmt so das Passwort, das der
Einrichtungs-Assistent gesetzt hat, auch aus einer neuen Shell ohne exportierte Variablen. Fehlt
`DEV_LOG_DATABASE_URL` überall, brechen die Skripte mit einer Meldung ab und schreiben weder Env-Datei noch Plist oder
Unit. Worker und Wächter laden fehlende Werte beim Start selbst aus der `.env` (nur Datenbank-URLs, Secret Key,
öffentliche Adresse, Domain und Projektbereich). Fehlt die URL, beenden sie sich mit einer Meldung im Log.

**Standardpasswort:** Ohne `DEV_LOG_DB_PASSWORD` in der `.env` nutzt die Datenbank das bekannte Passwort
`devlog_local_dev`. Server und Worker starten dann nicht, die Installationsskripte brechen ab, der Wächter warnt. Nur für
Wegwerf-Umgebungen lässt sich das mit `DEV_LOG_ALLOW_DEFAULT_DB_PASSWORD=1` erlauben. Zum Wechseln führst du
`./start.sh --setup` erneut aus (setzt ein zufälliges Passwort und ändert es per `ALTER USER` in PostgreSQL) und
installierst danach Worker und Wächter erneut.

**Testläufe und E2E:** Der Komplettlauf (`npm run test:full`) bekommt vom Worker nur `DEV_LOG_DATABASE_URL` und das
daraus abgeleitete Admin-Ziel `E2E_ADMIN_DATABASE_URL` (Datenbank `postgres`, gleicher Zugang). Secret Key und alle
anderen `DEV_LOG_*`-Werte bleiben draußen. Von Hand gestartet, lesen `test:full`, `seed:demo` und die E2E-Konfiguration
fehlende Zugänge aus `DEV_LOG_DB_USER` und `DEV_LOG_DB_PASSWORD` der `.env` (Port 5433). Fehlt dort das Passwort,
brechen sie mit einem Hinweis ab, statt das Standardpasswort zu versuchen.

### Container-Härtung

Jeder Dienst in `docker-compose.yml` hat Grenzen für Speicher, CPU und Prozesse und einen Healthcheck. Alle laufen mit
`no-new-privileges` und verwerfen sämtliche Linux-Capabilities (`cap_drop: [ALL]`). Zurück bekommen nur:

| Dienst | Capabilities | Grund |
|---|---|---|
| `db` | `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID` | Der Entrypoint übergibt das Datenverzeichnis an `postgres` und wechselt dann zu diesem Benutzer |
| `https` | `NET_BIND_SERVICE` | Caddy bindet die Ports 80/443 |
| `https-volumes` | `CHOWN`, `DAC_OVERRIDE` | Übergibt bestehende Zertifikats-Volumes einmalig an `caddy` |

`frontend` nutzt `nginxinc/nginx-unprivileged`: Auch der Master-Prozess läuft als `nginx`, auf Port 8080 (direkt) und
8081 (Caddy) im Container. `frontend`, `https` und `backup` laufen ohne root mit schreibgeschütztem Dateisystem
(`read_only`), beschreibbar sind nur `/tmp` (tmpfs) und ihre Volumes. `dev-log` (als `node`) schreibt Anhänge und Doku
zur Laufzeit und bleibt deshalb beschreibbar, ebenso `db`.

Der Review-Container läuft als Benutzer `node`. Jedes Projekt hat ein eigenes npm-Cache-Volume
(`aideation_review_npm_<projekt>` unter `/home/node/.npm`), damit ein Projekt den Cache der anderen nicht vergiften kann.
Das alte gemeinsame Volume `aideation_review_npm` wird nicht mehr benutzt und lässt sich mit
`docker volume rm aideation_review_npm` löschen.

### Docker-Sandbox für Agents (optional)

Mit dem Schalter `DEV_LOG_AGENT_SANDBOX` läuft der Entwickler-Agent in einem kurzlebigen Container statt direkt auf dem
Rechner. Der Worker bleibt auf dem Host und steuert den Lauf. Das Verhalten ist auf macOS, Linux und Windows gleich.

| Wert | Wirkung |
|---|---|
| `off` (Standard) | Alle Agents laufen wie bisher auf dem Host. |
| `docker` | Der Entwickler läuft im Image `aideation-agent`. Die anderen Rollen bleiben vorerst auf dem Host (Phase 1). |

**Einschalten:**

1. Image bauen, im AIdeation-Ordner: `docker build -t aideation-agent -f deploy/agent/Dockerfile .` Das geschieht auch
   bei jedem „AIdeation neu starten“ und im CI-Job `docker`. Das Image enthält Playwright mit Browsern, Node 22, die
   Claude-CLI in fester Version (Build-Argument `CLAUDE_CODE_VERSION`), Git, ripgrep und den gebündelten Wächter.
2. Anmeldung für die Claude-CLI im Container: `claude setup-token` ausführen und den Wert als
   `CLAUDE_CODE_OAUTH_TOKEN=…` in `worker.env` eintragen (alternativ `ANTHROPIC_API_KEY`). Das `~/.claude` des Hosts wird
   nicht eingebunden.
3. Schalter setzen: global als `DEV_LOG_AGENT_SANDBOX=docker` in `worker.env`, oder je Projekt unter Einstellungen →
   Projekt & Ordner → „Docker-Sandbox für den Entwickler“ (Wie global / Aus / Docker). Der Projektwert geht vor.
4. Worker neu starten.

Optional begrenzen `DEV_LOG_AGENT_SANDBOX_CPUS` (Standard `2`) und `DEV_LOG_AGENT_SANDBOX_MEMORY` (Standard `4g`) den
Container.

**Ist Docker nicht erreichbar oder fehlt das Image**, startet der Schritt nicht. Er scheitert mit einer Meldung im
Auftrag und im Worker-Badge und läuft nie stattdessen auf dem Host. Fehlt nur die Anmeldung, lautet die Meldung anders
(„Anmeldung der Claude-CLI fehlt“). Meldet die Claude-CLI ein Nutzungslimit, steht dabei, dass das kein Sandbox-Fehler
ist.

**Laufende Sandbox-Container anzeigen:** `docker ps --filter label=aideation.run`. Beim Start des Workers werden
übrig gebliebene Container mit diesem Label entfernt.

**node_modules:** Im Container liegen die Abhängigkeiten im Volume `aideation-node-modules-<projekt>` (Linux-Binärdateien,
darum nicht die des Hosts). Beim ersten Lauf ist es leer; der Agent installiert sie mit `npm ci --ignore-scripts`.
Zurücksetzen: `docker volume rm aideation-node-modules-<projekt>`.

### Log-Rotation (macOS)

`install-worker.sh` und `install-watchdog.sh` legen je eine `newsyslog`-Regel an:
`/etc/newsyslog.d/aideation-worker.conf` (ab 10 MB, 5 Stände) und `aideation-watchdog.conf` (ab 1 MB, 3 Stände). Die
Stände werden mit bzip2 gepackt (`aideation-worker.log.0.bz2` usw.). Die Regeln gehören `root:wheel`, darum fragt das
Skript einmal nach dem sudo-Passwort. Ein erneuter Lauf schreibt die Regel nur, wenn sie fehlt oder abweicht. Lehnst du
sudo ab, läuft die Installation trotzdem weiter, nur ohne Rotation.

Der Worker schreibt sein Log selbst (`DEV_LOG_LOG_FILE` in der Plist) und öffnet es nach der Rotation binnen 10 s neu.
`~/Library/Logs/aideation-worker.log` enthält also immer die aktuelle Ausgabe. Der Wächter startet alle zwei Minuten neu
und braucht das nicht. Liegt dein Home-Ordner unter einem Pfad mit Leerzeichen, legt das Skript keine Regel an (newsyslog
kann solche Pfade nicht lesen) und gibt eine Warnung aus. Unter Linux rotiert journald das Log.

### Client-IP hinter nginx

nginx (`deploy/frontend/nginx.conf`) hat zwei Eingänge mit denselben Routen (`app-locations.conf`):

- **Port 8080**, als `127.0.0.1:3100` veröffentlicht: für den direkten Zugriff vom eigenen Rechner. Die Client-IP ist
  die Socket-Adresse, das Protokoll `$scheme`. Mitgeschickte `X-Forwarded-For`, `X-Forwarded-Proto`,
  `X-Forwarded-Host`, `X-Real-IP` und `Forwarded` werden ersetzt bzw. entfernt.
- **Port 8081**, nicht veröffentlicht: nur für Caddy (`reverse_proxy frontend:8081`). Caddy ersetzt
  `X-Forwarded-For` durch die echte Client-IP. nginx übernimmt den letzten Eintrag (`set_real_ip_from` für private
  Netze, `real_ip_recursive off`). `X-Forwarded-Proto` gilt nur, wenn es genau `https` ist.

Das Backend bekommt in beiden Fällen genau eine Adresse in `X-Forwarded-For` und vertraut genau einem Hop
(`DEV_LOG_TRUST_PROXY: "1"`). Die Fehlversuchs-Sperre zählt so je echtem Client. Ein gefälschter Header beim
Direktzugriff ändert die Sperr-Adresse nicht.

Warum zwei Ports statt einer Prüfung nach Absender: Direktzugriffe über den Host-Port kommen vom Gateway desselben
Docker-Netzes, in dem auch Caddy läuft. Ein `set_real_ip_from` für dieses Netz würde also auch gefälschten Headern
glauben. Früher galt `uniquelocal`, und nginx hängte nur an ein mitgeschicktes `X-Forwarded-For` an. Damit war eine
vom Client vorangestellte Adresse die Client-IP. So ließ sich die Sperre mit wechselnden IPs umgehen.

Der Backup-Container schreibt als `70:70` (Benutzer `postgres` des Images) nach `./backups`. Die Dumps haben die
Rechte 600. Unter **Linux** muss der Ordner für diesen Benutzer beschreibbar sein. Sonst setzt du in der `.env`
`DEV_LOG_BACKUP_USER=<uid>:<gid>` deines Benutzers (`id -u`, `id -g`). Der Einrichtungs-Assistent trägt das selbst
ein. Unter macOS ist nichts zu tun.

Rotiert wird nur nach einem erfolgreichen Dump. Scheitert `pg_dump` (Passwort geändert, Laufwerk voll), bleiben alle
alten Backups liegen. Die neuesten `DEV_LOG_BACKUP_MIN_KEEP` (Standard 7) `aideation-*.dump` bleiben immer. Ältere
löscht das Skript erst, wenn sie älter als `DEV_LOG_BACKUP_KEEP_DAYS` (Standard 14) Tage sind. Andere Dateien in
`./backups` (fremde Präfixe, Handkopien) fasst es nicht an. Ungültige Werte (keine positive Zahl) ergeben den Standard.

### Wiederherstellen

Ein Backup spielst du mit `bash scripts/restore.sh backups/aideation-JJJJMMTT-HHMMSS.dump` ein. Das Skript stoppt
Worker, Wächter, API, Oberfläche und Backup-Dienst. Dann füllt es eine neue Datenbank und prüft mit einem
Entschlüsselungs-Test, ob `DEV_LOG_SECRET_KEY` passt. Erst dann ersetzt es `aideation`. Die alte Datenbank bleibt als
`aideation_vor_restore_<zeit>` liegen. Scheitert ein Schritt, bleibt die Live-Datenbank unverändert. Backups werden
dabei weder gelöscht noch rotiert.

- **Schlüssel:** Der `DEV_LOG_SECRET_KEY` aus der Zeit des Backups muss in `.env`, `worker.env` und `watchdog.env`
  stehen. Ohne ihn sind Projektzugänge, Zwei-Faktor-Schlüssel und der private Push-Schlüssel (VAPID) nicht lesbar.
  Bewahre ihn getrennt von den Backups auf, z. B. im Passwortmanager. Liegt er im selben Backup (etwa eine Kopie der
  `.env` in `./backups`), schützt die Verschlüsselung nichts.
- **Was im Backup verschlüsselt ist:** nur die Datenbank-Zugänge der Projekte (`projects.database_url`), die
  TOTP-Schlüssel (`users.totp_secret`/`totp_pending`, `app_settings.auth_totp_*`) und die VAPID-Schlüssel
  (`app_settings.push_vapid_keys`). Alles andere – Aufträge, Bugs, Doku, Agent-Ausgaben, Benutzernamen,
  Passwort-Hashes (scrypt), Push-Abos – steht lesbar im Dump. Behandle Backups deshalb wie die Datenbank selbst.
- **Zweite Kopie außer Haus:** `./backups` liegt auf demselben Rechner wie die Datenbank. Kopiere den Ordner deshalb
  regelmäßig an einen anderen Ort, z. B. auf ein externes Laufwerk oder verschlüsselt in die Cloud.
- **Probe:** `bash scripts/restore.sh --probe backups/<datei>.dump` spielt ein Backup in einen Wegwerf-Container
  (Port 5439) ein und löscht ihn danach. Der Wartungs-Job `restore_probe` macht das wöchentlich mit dem neuesten
  Backup.
- **pg_restore auf dem Worker-Rechner:** `backup_check` prüft jedes neue Backup mit `pg_restore --list`. Dafür
  brauchst du den Postgres-Client ab Version 17 (macOS: `brew install libpq`). Alternativ setzt du
  `DEV_LOG_PG_RESTORE=/pfad/zu/pg_restore` in der `worker.env`. Fehlt das Programm, meldet der Job einen Fehler.

## Fehlerbehebung

| Problem | Lösung |
|---|---|
| „Docker läuft nicht“ | Docker Desktop starten, dann erneut `./start.sh` |
| „Node.js … ist zu alt“ | Node.js 22.12 oder neuer installieren (Vite 8 und Angular 20 verlangen es) |
| Smoke-Test eines Spiels: „Executable doesn't exist“ | `npx playwright install chromium` im AIdeation-Ordner oder im Spielprojekt |
| Seite lädt nicht | `docker compose logs dev-log` – meist fehlt `DEV_LOG_PASSWORD` (mind. 16 Zeichen) in `.env` |
| Agents starten nicht | Worker-Status oben in AIdeation prüfen; `npm run worker` zeigt Fehler direkt |
| Worker-Log: „Env-Datei … fehlt“ oder „für andere lesbar“ | Installationsskript erneut ausführen bzw. `chmod 600` auf die Env-Datei |
| Backup-Container startet immer neu (Linux) | `./backups` ist für ihn nicht beschreibbar – `DEV_LOG_BACKUP_USER` setzen (siehe oben) |
| `backup_check`: „pg_restore --list nicht gefunden“ | Postgres-Client ab 17 installieren oder `DEV_LOG_PG_RESTORE` in der `worker.env` setzen |
| Restore: „Schlüssel-Test fehlgeschlagen“ | `DEV_LOG_SECRET_KEY` aus der Zeit des Backups in `.env` und `worker.env` eintragen |
| Zwei-Faktor-Gerät verloren | siehe README, Abschnitt Sicherheit |
| Start bricht ab: „Zwei-Faktor-Schlüssel brauchen DEV_LOG_SECRET_KEY“ | Den bisherigen `DEV_LOG_SECRET_KEY` in der `.env` wieder eintragen und neu starten |
| Start bricht ab: „Push-Schlüssel brauchen DEV_LOG_SECRET_KEY“ | Wie oben. Ohne Schlüssel bleibt der alte VAPID-Schlüssel unverändert in der Datenbank, gelöscht wird nichts |
| Wächter schickt nach dem Update keine Push-Nachricht | `DEV_LOG_SECRET_KEY` fehlt in `watchdog.env`: `DEV_LOG_SECRET_KEY=… ./scripts/install-watchdog.sh` erneut ausführen |
| Nach dem Update überall abgemeldet | Gewollt: Sitzungen von vor der Passwort-Bindung gelten nicht mehr, einmal neu anmelden |
| Nach neuem `DEV_LOG_PASSWORD` abgemeldet | Gewollt: Eine Passwortrotation beendet alle Sitzungen des Systemadministrators |
| Zu viele Fehlversuche | Die Meldung nennt die Wartezeit (1 bis höchstens 15 Minuten). Gebremst wird nur dieses Konto von dieser Adresse aus, von einem anderen Gerät oder Netz geht die Anmeldung weiter |
| Start bricht ab: „Standardpasswort … Start abgebrochen“ | `./start.sh --setup` erneut ausführen (setzt `DEV_LOG_DB_PASSWORD` und ändert es in PostgreSQL), danach den Worker neu installieren. Nur für Wegwerf-Umgebungen: `DEV_LOG_ALLOW_DEFAULT_DB_PASSWORD=1` |
| „Unbekannter Host“ (Status 421) | AIdeation wird über einen Namen aufgerufen, der weder IP, `localhost`, `*.local` noch `DEV_LOG_DOMAIN` ist (Schutz vor DNS-Rebinding). Namen in `DEV_LOG_ALLOWED_HOSTS` der `.env` eintragen (Komma-getrennt) und neu starten |
| Alle Geräte werden gemeinsam gebremst | Das Backend sieht nur die Proxy-Adresse. `DEV_LOG_TRUST_PROXY` muss den Proxy abdecken (Compose: `1`), `true` wird abgelehnt (Warnung im Log von `dev-log`). Caddy muss an `frontend:8081` weiterleiten, nicht an 8080 (siehe „Client-IP hinter nginx“) |
