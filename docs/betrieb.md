# AIdeation betreiben

Nachschlagewerk für den Betrieb nach der Installation: Worker, Container, Arbeitscontainer der Agents, Backups und
Fehlerbehebung. Die Installation selbst Schritt für Schritt steht in [Installation](installation.md).

## Einrichtung wiederholen

Mit `./start.sh --setup` (Windows: `start.cmd --setup`) öffnest du den Einrichtungs-Assistenten erneut. Die bisherige
`.env` wird vorher als `.env.bak-<Zeit>` gesichert und dann **ergänzt, nicht ersetzt**:

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
- Der Worker bekommt den Secret Key mit: im Container über `docker-compose.yml` aus der `.env`, auf dem Host über den
  macOS-LaunchAgent, den Linux-systemd-Dienst bzw. die Windows-Aufgabe `AIdeationWorker` (startet `scripts\run-with-env.ps1`, Umgebung in `%LOCALAPPDATA%\AIdeation\worker.env`) der
  Aufgabe `AIdeationWorker`.
- Läuft die Einrichtung schon in einem anderen Fenster, lehnt der Assistent einen zweiten Start ab. Nach einem
  Fehler bleibt er offen, ein neuer Versuch ist mit „Zurück“ möglich.

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
docker compose logs -f worker     # Protokoll des Workers im Container (Wächter: watchdog)
npm run worker                    # Worker auf dem Host im Vordergrund starten (ohne Autostart)
./start.sh --setup                # Einrichtung wiederholen
```

Jedes Projekt liegt in einem eigenen Ordner mit `source` (Code, z. B. mit laufendem Entwicklungsserver) und
`agent` (Arbeitsordner der Agents, Git-Worktree) – AIdeation selbst ebenso: `AIdeation/source` und `AIdeation/agent`.

Die Container heissen `aideation_frontend_angular` (Oberfläche, nginx, leitet `/api` weiter), `aideation_backend_nodejs`
(API), `aideation_database_postgres` (Datenbank), `aideation_backup_postgres` (Sicherung, etwa täglich) und
`aideation_proxy_caddy` (HTTPS, optional), mit dem Worker im Container zusätzlich `aideation_worker_nodejs` (Worker) und
`aideation_watchdog_nodejs` (Ausfall-Wächter). In den Befehlen oben stehen die Dienstnamen (`frontend`, `dev-log`, `db`,
`backup`, `https`, `worker`, `watchdog`); `docker exec` braucht den Containernamen, z. B.
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

## Worker im Container

Mit dem Profil `worker` in `COMPOSE_PROFILES` (der Einrichtungs-Assistent setzt es, zusammen mit `https`, falls eine
Domain gewählt ist) startet `docker compose up -d` drei weitere Dienste aus dem Image `aideation-worker`
(`deploy/worker/Dockerfile`: Node 22, Git, SSH, `gh`, Docker-CLI mit Compose und Buildx):

| Dienst | Aufgabe |
|---|---|
| `worker` | Dauer-Worker für alle Projekte (wie `npm run worker`). **Einziger Dienst mit dem Docker-Socket** (`/var/run/docker.sock`): startet die Arbeitscontainer und Agent-Container und baut beim Neustart die Images. |
| `worker-volumes` | Einmaliger Schritt vor dem Worker: übergibt das Volume für `node_modules` dem Worker-Benutzer, dann Ende. |
| `watchdog` | Ausfall-Wächter: alle zwei Minuten ein Prüflauf mit denselben Push-Meldungen wie bisher. Ohne Docker-Socket und ohne Git-Zugang, AIdeation-Ordner nur lesend. |

**Pfade:** Der Worker gibt Projektpfade an `docker run` weiter, und der Docker-Daemon löst sie auf dem Host auf. Deshalb
sind der AIdeation-Ordner und jeder Ordner aus `DEV_LOG_PROJECT_ROOTS` im Worker **mit demselben Pfad wie auf dem Host**
eingebunden (ohne Projektbereich: der Ordner, in dem AIdeation liegt). Unter Windows gilt der Pfad von Docker Desktop:
`C:\Users\du\Projekte` liegt im Worker unter `/c/Users/du/Projekte`. In der Oberfläche eingetragene Windows-Pfade
übersetzt der Worker selbst. Da sich Ordnerlisten in Compose nicht aufzählen lassen, schreibt `scripts/worker-compose.ts`
sie in `docker-compose.override.yml`. Compose lädt diese Datei automatisch. `start.sh` bzw. `start.cmd` erzeugen sie bei
jedem Start neu, so gilt ein geänderter Projektbereich nach dem nächsten Start. Die Datei steht in `.gitignore`. Eine
selbst angelegte `docker-compose.override.yml` ohne die Kennzeichnung in der ersten Zeile wird nie überschrieben.
Von Hand: `npx tsx scripts/worker-compose.ts`, danach `docker compose up -d`.

Auf macOS muss der Ordner der Projekte in Docker Desktop unter **Settings → Resources → File sharing** freigegeben
sein (z. B. `/Volumes/…`). Das gilt schon für die Agent-Sandbox.

**Git-Zugang nur für den Worker, schreibgeschützt:** `docker-compose.override.yml` bindet nur in den Dienst `worker` ein,
was es auf dem Host gibt, jeweils `read_only`:

| Host | Im Worker | Anders per `.env` |
|---|---|---|
| `~/.ssh` | `/home/worker/.ssh` | `DEV_LOG_WORKER_SSH_DIR` |
| `~/.config/gh` | `/home/worker/.config/gh` | `DEV_LOG_WORKER_GH_CONFIG_DIR` |
| `~/.gitconfig` | `/home/worker/.gitconfig` | `DEV_LOG_WORKER_GITCONFIG` |
| `~/.config/aideation/github-token` | `/run/secrets/github_token` → `GH_TOKEN` | `DEV_LOG_WORKER_GITHUB_TOKEN_FILE` |

`gh` hält den Token unter macOS und Windows im Schlüsselbund, den der Container nicht sieht. Der Assistent legt ihn
deshalb einmalig aus `gh auth token` in `~/.config/aideation/github-token` ab (Rechte 600). Von Hand geht das mit
`gh auth token > ~/.config/aideation/github-token && chmod 600 ~/.config/aideation/github-token`. Agent-Container
bekommen keinen dieser Zugänge, auch keinen Docker-Socket des Rechners: Sie haben ihr eigenes Docker im Stapel und
bekommen nur eine gefilterte Umgebung (siehe [Arbeitscontainer für Agents](#arbeitscontainer-für-agents)).

**Benutzer:** Der Worker läuft ohne root als `DEV_LOG_WORKER_USER` (Standard `1000:1000`; unter Linux trägt der
Assistent deine `uid:gid` ein, damit Dateien in den Projektordnern dir gehören). Zugriff auf Docker bekommt er über
die Gruppe des Sockets `DEV_LOG_DOCKER_GID`. Unter Linux trägt der Assistent die Gruppe `docker` ein, sonst gilt `0`
(Docker Desktop).

**Anmeldung der Agents:** `CLAUDE_CODE_OAUTH_TOKEN` (aus `claude setup-token`, Feld im Assistenten) bzw.
`ANTHROPIC_API_KEY` in der `.env`. Der Worker reicht ihn wie bisher nur als Name (`-e NAME`) an die Agent-Container
weiter. Der Worker im Container nutzt immer die Docker-Sandbox (`DEV_LOG_AGENT_SANDBOX=docker`): Eine Claude-CLI gibt
es im Worker-Image nicht. Ollama erreicht er unter `host.docker.internal:11434` (`DEV_LOG_WORKER_OLLAMA_URL`). Die
Datenbank erreicht er im Compose-Netz unter `db:5432`. Für eine Review-Datenbank (`scripts/setup-review-db.sh`) gilt
deshalb `DEV_LOG_WORKER_REVIEW_DATABASE_URL` mit Host `db:5432` statt `localhost:5433`.

**Neustart:** „AIdeation neu starten“ läuft im Worker über den Socket. Er holt den Stand von `origin`, bringt bei
Bedarf `node_modules` im Volume auf den Stand des Lockfiles und baut mit `docker compose up -d --build` alle Dienste
ausser `worker`, `worker-volumes` und `watchdog` neu. Sonst ersetzte Compose den Container, in dem der Neubau gerade
läuft. Zudem löst nur Compose auf dem Host die Ordner aus `docker-compose.override.yml` richtig auf (unter Windows
`C:\…`). Der Wächter lädt den neuen Code ohnehin bei jedem Prüflauf. Danach baut der Worker das Agent-Image und das
Worker-Image, prüft die Oberfläche (`http://frontend:8080/health`) und beendet sich mit Exit-Code 75.
Die Restart-Richtlinie (`restart: unless-stopped`) startet ihn sofort wieder. Er lädt dann den neuen Code aus dem
eingebundenen AIdeation-Ordner, das Worker-Badge wird wieder grün. Ein neues Worker-Image (nur Werkzeuge, kein Code)
gilt ab dem nächsten `./start.sh` bzw. `docker compose up -d`.

**Gesundheit:** `docker compose ps worker` zeigt `healthy`, solange der Worker sein Lebenszeichen in die Datenbank
schreibt. Beim ersten Start installiert er `node_modules` (`npm ci --ignore-scripts`, einige Minuten), deshalb hat der
Healthcheck 15 Minuten Anlaufzeit. Der Wächter ist `healthy`, solange seine Prüfläufe durchlaufen.

**Umstieg vom Worker auf dem Host:** Zuerst den alten Dienst stoppen, sonst laufen zwei Worker. Der zweite beendet sich
zwar wegen der Datenbank-Sperre, meldet das aber bei jedem Neustart:

| System | Befehl |
|---|---|
| macOS | `launchctl bootout gui/$(id -u)/com.aideation.worker; launchctl bootout gui/$(id -u)/com.aideation.watchdog` |
| Linux | `systemctl --user disable --now aideation-worker.service` |
| Windows | `Unregister-ScheduledTask -TaskName AIdeationWorker -Confirm:$false` |

Danach `./start.sh --setup` mit „Worker im Container“. Zurück zum Host: im Assistenten „Worker auf diesem Rechner“
wählen. Er entfernt das Profil `worker` aus `COMPOSE_PROFILES` und stoppt die beiden Container.

## Worker auf dem Host: Dienste und Zugänge

Dieser Abschnitt gilt für den **Worker auf dem Host**. Die Installationsskripte (`scripts/install-worker.sh`, `install-watchdog.sh`, `install-worker-linux.sh`,
`install-worker.ps1`) schreiben die Zugänge (`DEV_LOG_DATABASE_URL`, `DEV_LOG_SECRET_KEY`) in eine **Env-Datei, die nur
du lesen kannst**. In Plist, systemd-Unit oder Befehlszeile der geplanten Aufgabe stehen sie nicht mehr. Beim Start liest
die Datei unter macOS Node selbst (`--env-file`), unter Linux `scripts/run-with-env.sh`, unter Windows `run-with-env.ps1`. Fehlt sie oder können andere sie lesen, bricht der Start
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

## Container-Härtung

Jeder Dienst in `docker-compose.yml` hat Grenzen für Speicher, CPU und Prozesse und einen Healthcheck. Alle laufen mit
`no-new-privileges` und verwerfen sämtliche Linux-Capabilities (`cap_drop: [ALL]`). Zurück bekommen nur:

| Dienst | Capabilities | Grund |
|---|---|---|
| `db` | `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID` | Der Entrypoint übergibt das Datenverzeichnis an `postgres` und wechselt dann zu diesem Benutzer |
| `https` | `NET_BIND_SERVICE` | Caddy bindet die Ports 80/443 |
| `https-volumes` | `CHOWN`, `DAC_OVERRIDE` | Übergibt bestehende Zertifikats-Volumes einmalig an `caddy` |
| `worker-volumes` | `CHOWN`, `DAC_OVERRIDE` | Übergibt das `node_modules`-Volume des Workers einmalig an dessen Benutzer |

Der Dienst `worker` braucht keine Capability. Er ist aber der einzige mit dem Docker-Socket, und wer den Socket hat,
steuert Docker auf dem Rechner. Ein Test (`src/runner/container-hardening.test.ts`) liest deshalb `docker-compose.yml`
und schlägt fehl, sobald ein anderer Dienst den Socket einbindet. `watchdog` läuft wie `frontend` mit
schreibgeschütztem Dateisystem.

`frontend` nutzt `nginxinc/nginx-unprivileged`: Auch der Master-Prozess läuft als `nginx`, auf Port 8080 (direkt) und
8081 (Caddy) im Container. `frontend`, `https` und `backup` laufen ohne root mit schreibgeschütztem Dateisystem
(`read_only`), beschreibbar sind nur `/tmp` (tmpfs) und ihre Volumes. `dev-log` (als `node`) schreibt Anhänge und Doku
zur Laufzeit und bleibt deshalb beschreibbar, ebenso `db`.

Der Review-Container läuft als Benutzer `node`. Jedes Projekt hat ein eigenes npm-Cache-Volume
(`aideation_review_npm_<projekt>` unter `/home/node/.npm`), damit ein Projekt den Cache der anderen nicht vergiften kann.
Das alte gemeinsame Volume `aideation_review_npm` wird nicht mehr benutzt und lässt sich mit
`docker volume rm aideation_review_npm` löschen.

## Arbeitscontainer für Agents

Agents und Projekttests laufen nicht auf deinem Rechner, sondern **je Projekt in einem eigenen Arbeitscontainer**
(Schalter `DEV_LOG_AGENT_SANDBOX`, Standard `workbench`). Darin dürfen sie alles, was ein Entwickler-Rechner kann:
Pakete installieren, bauen, Tests mit Browsern ausführen und **mit Docker eigene Container bauen und starten**. Dein
Rechner, sein Docker und die anderen Projekte bleiben davon unberührt. Das Verhalten ist auf macOS, Linux und Windows
gleich. Das gilt für den Worker auf dem Host; der Compose-Dienst `worker` setzt fest `DEV_LOG_AGENT_SANDBOX=docker`
(kurzlebige Container je Schritt, siehe oben).

Ein Arbeitscontainer ist ein kleiner Compose-Stapel `agents_<projekt>` je Projekt (in Docker Desktop eine Gruppe je Anwendung). Seine Container heissen `agents_<projekt>_workbench`, `agents_<projekt>_docker` und `agents_<projekt>_<dienst>` für die Testdienste:

| Dienst | Aufgabe |
|---|---|
| `workbench` | Image `aideation-agent` (Node 22, Playwright mit Browsern, Claude-CLI, Git, Docker-CLI mit Compose und Buildx). Der Arbeitsordner des Projekts liegt unter `/workspace`, `node_modules` im Volume `aideation-node-modules-<projekt>`. Ohne Rechte (`cap_drop: ALL`), Netzwerk nur über den Egress-Proxy. |
| `docker` | Eigener Docker-Dienst des Stapels (`docker:29-dind-rootless`). Er läuft **nicht privilegiert**: `dockerd` als Benutzer `rootless` in einem eigenen Benutzer-Namensraum, ohne Rechte (`cap_drop: ALL`, nur `SETUID`/`SETGID` für `newuidmap`), ohne Geräte des Rechners (nur `/dev/net/tun` für sein Netz) und mit aufgehobenem seccomp/AppArmor/`systempaths` (sonst kann rootlesskit kein `proc` einhängen). Images, Container und Volumes der Agents liegen in seinem Volume `agents_<projekt>_docker_rootless`, nie im Docker deines Rechners. Er lauscht nur innerhalb des Stapels (`127.0.0.1:2375`), auch die inneren Container erreichen seine API nicht. Innere Container können nicht `--privileged` laufen, und innere Speicher-/CPU-Grenzen gelten nicht (kein cgroup); dafür gelten die Grenzen dieses Containers (wie `workbench`). Das Volume `agents_<projekt>_docker` des früheren privilegierten Dienstes bleibt ungenutzt und lässt sich mit `docker volume rm agents_<projekt>_docker` entfernen. |
| Testdienste | Aus `.aideation/workbench.json` des Projekts, z. B. Postgres für die Tests (siehe unten). |

Alle Dienste teilen sich das Netzwerk der `workbench`: Was die Agents mit Docker starten oder was als Testdienst
läuft, erreichen sie wie gewohnt unter `localhost`.

**Was beim Worker bleibt:** Git-Push, Merge nach `main`, Live schalten und das Bauen der echten Container macht
weiterhin der Worker. Deine GitHub-Schlüssel, `~/.ssh`, `~/.claude` und der Docker-Socket deines Rechners kommen nie
in einen Arbeitscontainer. Lesende Rollen (Visionär, Problemanalyse, Schätzung) laufen weiterhin in kurzlebigen
Containern mit nur lesendem Arbeitsordner.

**Netzwerk:** Hinaus geht es nur über den Egress-Proxy `aideation-egress`: Anthropic-API, npm-Registry, Ollama auf dem
Host und Docker Hub (Images für das Docker im Stapel). Weitere Ziele gibst du ausdrücklich mit
`DEV_LOG_AGENT_SANDBOX_EGRESS=host:port,host:port` in `worker.env` (bzw. `.env`) frei. Nach einer Änderung den Proxy
einmal entfernen, AIdeation legt ihn neu an: `docker rm -f aideation-egress`.

| Wert von `DEV_LOG_AGENT_SANDBOX` | Wirkung |
|---|---|
| `workbench` (Standard) | Arbeitscontainer je Projekt wie oben. |
| `docker` | Früheres Verhalten: jeder Schritt in einem neuen, kurzlebigen Container `aideation-agent` ohne eigenes Docker. Testdienste mit dem Compose-Label `aideation.test: "true"` startet der Worker auf dem Host. |
| `off` | Notfallmodus: Alles läuft wieder direkt auf dem Rechner. Das Worker-Badge zeigt eine Warnung. |

**Einrichten:**

1. **Docker Desktop:** Arbeitsspeicher auf mindestens 12 GB, besser 16 GB stellen (Einstellungen → Resources).
2. **Image bauen**, im AIdeation-Ordner: `docker build -t aideation-agent -f deploy/agent/Dockerfile .` Das geschieht
   auch bei jedem „AIdeation neu starten“ und im CI-Job `docker`. Die Claude-CLI hat eine feste Version
   (Build-Argument `CLAUDE_CODE_VERSION`).
3. **Anmeldung der Claude-CLI:** `claude setup-token` ausführen und den Wert als `CLAUDE_CODE_OAUTH_TOKEN=…` in
   `~/.config/aideation/worker.env` eintragen (alternativ `ANTHROPIC_API_KEY`). Mit dem Worker im Container gehört er in
   die `.env` (Feld im Assistenten). Das `~/.claude` des Rechners wird nicht eingebunden.
4. **Schalter (optional):** Ohne Angabe gilt `workbench` (der Compose-Dienst `worker` setzt `docker`). Abweichend global in `worker.env` oder je Projekt unter
   Einstellungen → Projekt & Ordner → „Docker-Sandbox für Agents und Projekttests“. Der Projektwert geht vor.
5. **Worker neu starten.** Den Arbeitscontainer legt der Worker beim ersten Agent-Schritt bzw. Testlauf des Projekts
   selbst an; der erste Start dauert wegen der Images und der Installation der Abhängigkeiten einige Minuten.

**Grenzen je Arbeitscontainer:** `DEV_LOG_AGENT_SANDBOX_CPUS` (Standard `4`) und `DEV_LOG_AGENT_SANDBOX_MEMORY`
(Standard `6g`). Für die kurzlebigen Container (`docker`) gelten dieselben Variablen mit den Standards `2` und `4g`.

**Testdienste eines Projekts:** Braucht ein Projekt für seine Tests z. B. eine Datenbank, legst du im Projekt die
Datei `.aideation/workbench.json` an. Der Worker liest sie aus dem **Live-Ordner** des Projekts (dem geprüften Stand
auf `main`), nicht aus dem Arbeitsordner der Agents – ein Agent kann sich so keine weiteren Rechte geben. Erlaubt sind
je Dienst nur `image`, `environment`, `command` und `tmpfs`; Ports, Mounts, Rechte und Netzwerke setzt AIdeation
selbst. `environment` auf oberster Ebene gilt für die `workbench`. Beispiel (gekürzt aus der `.aideation/workbench.json`, mit der AIdeation sich selbst testet; die echte Datei setzt zusätzlich `DEV_LOG_ADMIN_DATABASE_URL`, `E2E_ADMIN_DATABASE_URL` und `DEV_LOG_TEST_REQUIRE_DATABASE`):

```json
{
  "services": {
    "postgres": {
      "image": "postgres:17-alpine",
      "environment": { "POSTGRES_USER": "devlog", "POSTGRES_PASSWORD": "workbench", "POSTGRES_DB": "aideation" },
      "command": ["-p", "5433"],
      "tmpfs": ["/var/lib/postgresql/data"]
    }
  },
  "environment": {
    "DEV_LOG_DATABASE_URL": "postgresql://devlog:workbench@127.0.0.1:5433/aideation"
  }
}
```

Ändert sich die Datei, das Image oder eine Grenze, erstellt der Worker den Stapel beim nächsten Lauf neu. Das Docker-
und das `node_modules`-Volume bleiben dabei erhalten.

**Abhängigkeiten:** Vor dem ersten Lauf und nach jeder Änderung an `package-lock.json` installiert der Worker sie im
Arbeitscontainer (`npm install --ignore-scripts`, Linux-Binärdateien, darum nicht die des Rechners). Zurücksetzen:
`docker volume rm aideation-node-modules-<projekt>` (bei gestopptem Arbeitscontainer).

**Ist Docker nicht erreichbar, fehlt das Image oder startet der Stapel nicht**, beginnt der Schritt nicht. Er scheitert
mit einer Meldung im Auftrag und im Worker-Badge und läuft nie stattdessen auf deinem Rechner. Fehlt nur die
Anmeldung, lautet die Meldung „Anmeldung der Claude-CLI fehlt“. Meldet die Claude-CLI ein Nutzungslimit, steht dabei,
dass das kein Sandbox-Fehler ist.

**Nützliche Befehle:**

```bash
# Arbeitscontainer anzeigen
docker ps --filter label=aideation.workbench
# In einen Arbeitscontainer schauen
docker exec -it agents_<projekt>_workbench bash
# Arbeitscontainer stoppen (Volumes bleiben; der Worker startet ihn bei Bedarf neu)
docker compose -p agents_<projekt> -f ~/.config/aideation/workbench/agents_<projekt>.json down
# Kurzlebige Container (Modus docker) anzeigen
docker ps --filter label=aideation.run
```

Die Compose-Dateien der Arbeitscontainer legt der Worker unter `~/.config/aideation/workbench/` ab (anders mit
`DEV_LOG_WORKBENCH_DIR`). Sie enthalten keine Geheimnisse.

## Log-Rotation (macOS)

`install-worker.sh` und `install-watchdog.sh` legen je eine `newsyslog`-Regel an:
`/etc/newsyslog.d/aideation-worker.conf` (ab 10 MB, 5 Stände) und `aideation-watchdog.conf` (ab 1 MB, 3 Stände). Die
Stände werden mit bzip2 gepackt (`aideation-worker.log.0.bz2` usw.). Die Regeln gehören `root:wheel`, darum fragt das
Skript einmal nach dem sudo-Passwort. Ein erneuter Lauf schreibt die Regel nur, wenn sie fehlt oder abweicht. Lehnst du
sudo ab, läuft die Installation trotzdem weiter, nur ohne Rotation.

Der Worker schreibt sein Log selbst (`DEV_LOG_LOG_FILE` in der Plist) und öffnet es nach der Rotation binnen 10 s neu.
`~/Library/Logs/aideation-worker.log` enthält also immer die aktuelle Ausgabe. Der Wächter startet alle zwei Minuten neu
und braucht das nicht. Liegt dein Home-Ordner unter einem Pfad mit Leerzeichen, legt das Skript keine Regel an (newsyslog
kann solche Pfade nicht lesen) und gibt eine Warnung aus. Unter Linux rotiert journald das Log.

## Client-IP hinter nginx

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

## Backups

Der Backup-Container schreibt als `70:70` (Benutzer `postgres` des Images) nach `./backups`. Die Dumps haben die
Rechte 600. Unter **Linux** muss der Ordner für diesen Benutzer beschreibbar sein. Sonst setzt du in der `.env`
`DEV_LOG_BACKUP_USER=<uid>:<gid>` deines Benutzers (`id -u`, `id -g`). Der Einrichtungs-Assistent trägt das selbst
ein. Unter macOS ist nichts zu tun.

Rotiert wird nur nach einem erfolgreichen Dump. Scheitert `pg_dump` (Passwort geändert, Laufwerk voll), bleiben alle
alten Backups liegen. Die neuesten `DEV_LOG_BACKUP_MIN_KEEP` (Standard 7) `aideation-*.dump` bleiben immer. Ältere
löscht das Skript erst, wenn sie älter als `DEV_LOG_BACKUP_KEEP_DAYS` (Standard 14) Tage sind. Andere Dateien in
`./backups` (fremde Präfixe, Handkopien) fasst es nicht an. Ungültige Werte (keine positive Zahl) ergeben den Standard.

## Wiederherstellen

Ein Backup spielst du mit `bash scripts/restore.sh backups/aideation-JJJJMMTT-HHMMSS.dump` ein. Das Skript stoppt
den Worker und den Wächter auf dem Host (launchd bzw. systemd) sowie API, Oberfläche und Backup-Dienst. **Laufen Worker und
Wächter als Compose-Dienste** (Profil `worker`), stoppst du sie vorher selbst mit `docker compose --profile worker stop worker watchdog`
und startest sie danach wieder; das Skript fasst sie nicht an (`scripts/restore.sh`). Dann füllt es eine neue Datenbank und prüft mit einem
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
- **pg_restore:** `backup_check` prüft jedes neue Backup mit `pg_restore --list`. Im Worker-Container ist der
  Postgres-Client 17 schon im Image. Für den Worker auf dem Host brauchst du ihn ab Version 17 (macOS: `brew install libpq`). Alternativ setzt du
  `DEV_LOG_PG_RESTORE=/pfad/zu/pg_restore` in der `worker.env`. Fehlt das Programm, meldet der Job einen Fehler.

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

## Fehlerbehebung (Betrieb)

| Problem | Lösung |
|---|---|
| „Docker läuft nicht“ | Docker Desktop starten, dann erneut `./start.sh` |
| „Node.js … ist zu alt“ | Node.js 22.12 oder neuer installieren (Vite 8 und Angular 20 verlangen es) |
| Smoke-Test eines Spiels: „Executable doesn't exist“ | `npx playwright install chromium` im AIdeation-Ordner oder im Spielprojekt |
| Seite lädt nicht | `docker compose logs dev-log` – meist fehlt `DEV_LOG_PASSWORD` (mind. 16 Zeichen) in `.env` |
| Agents starten nicht | Worker-Status oben in AIdeation prüfen; `npm run worker` zeigt Fehler direkt |
| Worker-Log: „Env-Datei … fehlt“ oder „für andere lesbar“ | Installationsskript erneut ausführen bzw. `chmod 600` auf die Env-Datei |
| Backup-Container startet immer neu (Linux) | `./backups` ist für ihn nicht beschreibbar – `DEV_LOG_BACKUP_USER` setzen (siehe oben) |
| `backup_check`: „pg_restore --list nicht gefunden“ | Worker im Container: Image neu bauen (`docker compose build worker`, dann `docker compose up -d`). Auf dem Host: Postgres-Client ab 17 installieren oder `DEV_LOG_PG_RESTORE` in der `worker.env` setzen |
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
