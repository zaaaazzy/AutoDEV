# AIdeation installieren

AIdeation besteht aus drei Teilen:

| Teil | Läuft | Aufgabe |
|---|---|---|
| **AIdeation** (Oberfläche + API) | in Docker | Projekte, Ideen, Aufträge, Sprints, Dokumentation |
| **Datenbank** (PostgreSQL) + tägliche Backups | in Docker | alle Daten, Backups unter `backups/` |
| **Worker** | direkt auf deinem Rechner | startet die Agents in deinen Projektordnern |

## Voraussetzungen

- **Docker Desktop** (macOS, Windows) bzw. Docker Engine mit Compose (Linux) – läuft beim Start.
- **Node.js 22** oder neuer – für Worker und Einrichtung.
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

1. **System** – prüft Node, Docker, Git, Claude Code und Ollama.
2. **Zugang** – Benutzername und Passwort des Systemadministrators (ein sicheres Passwort wird vorgeschlagen).
3. **Optionen** – eigene Domain für HTTPS von unterwegs (optional), erlaubte Projektordner, Worker-Autostart.
4. **Installation** – schreibt die `.env`, baut und startet die Container, richtet den Worker ein
   (macOS: launchd, Linux: systemd-Benutzerdienst, Windows: Aufgabenplanung). Das Protokoll läuft live mit.

Danach öffnet sich AIdeation unter `http://localhost:3100`. Nach der Anmeldung begrüßt dich AIdeation und bietet an,
das erste Projekt anzulegen.

Bei **späteren Starts** startet `./start.sh` bzw. `start.cmd` nur die Dienste und öffnet AIdeation.
Mit `./start.sh --setup` (Windows: `start.cmd --setup`) öffnest du den Assistenten erneut. Die bisherige `.env`
wird vorher als `.env.bak-<Zeit>` gesichert und dann **ergänzt, nicht ersetzt**:

- Gesetzt werden nur Benutzername, Passwort und die ausgefüllten Optionen. Leere Felder (Domain, Projektbereich)
  lassen bestehende Werte stehen. Eigene Einträge, Kommentare und die Reihenfolge bleiben erhalten.
- **Secret Key** (`DEV_LOG_SECRET_KEY`): Fehlt er oder ist er leer, erzeugt der Assistent einen zufälligen Schlüssel.
  Ein vorhandener Schlüssel wird nie ersetzt. Mit ihm werden die Zugangsdaten der Projekte verschlüsselt.
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

## Zugriff von unterwegs (optional)

Mit eigener Domain im Assistenten startet zusätzlich der Dienst `https` (Caddy) und holt automatisch ein
Let's-Encrypt-Zertifikat. Dafür muss dein Router **Port 443** (TCP) an diesen Rechner weiterleiten und die Domain
auf deine öffentliche IP zeigen. AIdeation ist dann installierbar als App (Handy: „Zum Home-Bildschirm“) und schickt
Push-Nachrichten.

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
(API), `aideation_database_postgres` (Datenbank), `aideation_backup_postgres` (tägliche Sicherung) und
`aideation_proxy_caddy` (HTTPS, optional). In den Befehlen oben stehen die Dienstnamen (`frontend`, `dev-log`, `db`,
`backup`, `https`); `docker exec` braucht den Containernamen, z. B.
`docker exec -it aideation_database_postgres psql -U devlog aideation`.

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

**Umstieg von älteren Installationen:** Ältere Skripte schrieben die Zugänge direkt in Plist bzw. Unit (für alle lesbar)
und unter Windows in die Befehlszeile der Aufgabe. Führe das passende Skript einmal erneut aus. Es ersetzt die alte
Plist bzw. Unit, unter Windows die Aufgabe. Danach stehen keine Zugänge mehr darin. Wurde das Datenbank-Passwort früher
in einer Plist oder Unit gespeichert, solltest du es ändern.

**Standardpasswort:** Ohne `DEV_LOG_DB_PASSWORD` in der `.env` nutzt die Datenbank das bekannte Passwort
`devlog_local_dev`. Server, Wächter und Installationsskripte warnen dann. Zum Wechseln setzt du das Passwort in
PostgreSQL (`ALTER USER devlog PASSWORD '…'`), trägst es in die `.env` ein, startest mit `docker compose up -d` neu
und installierst den Worker mit der neuen `DEV_LOG_DATABASE_URL` erneut.

### Container-Härtung

Jeder Dienst in `docker-compose.yml` hat Grenzen für Speicher, CPU und Prozesse und einen Healthcheck. `frontend`
(nginx, Port 8080 im Container), `https` (Caddy) und `backup` laufen ohne root und ohne Linux-Capabilities. Caddy
behält nur `NET_BIND_SERVICE` für die Ports 80/443. Der einmalige Dienst `https-volumes` übergibt bestehende
Zertifikats-Volumes an den Benutzer `caddy` und beendet sich danach. Der Review-Container läuft als Benutzer `node`.

Der Backup-Container schreibt als `70:70` (Benutzer `postgres` des Images) nach `./backups`. Die Dumps haben die
Rechte 600. Unter **Linux** muss der Ordner für diesen Benutzer beschreibbar sein. Sonst setzt du in der `.env`
`DEV_LOG_BACKUP_USER=<uid>:<gid>` deines Benutzers (`id -u`, `id -g`). Der Einrichtungs-Assistent trägt das selbst
ein. Unter macOS ist nichts zu tun.

## Fehlerbehebung

| Problem | Lösung |
|---|---|
| „Docker läuft nicht“ | Docker Desktop starten, dann erneut `./start.sh` |
| Seite lädt nicht | `docker compose logs dev-log` – meist fehlt `DEV_LOG_PASSWORD` (mind. 16 Zeichen) in `.env` |
| Agents starten nicht | Worker-Status oben in AIdeation prüfen; `npm run worker` zeigt Fehler direkt |
| Worker-Log: „Env-Datei … fehlt“ oder „für andere lesbar“ | Installationsskript erneut ausführen bzw. `chmod 600` auf die Env-Datei |
| Backup-Container startet immer neu (Linux) | `./backups` ist für ihn nicht beschreibbar – `DEV_LOG_BACKUP_USER` setzen (siehe oben) |
| Zwei-Faktor-Gerät verloren | siehe README, Abschnitt Sicherheit |
| Zu viele Fehlversuche | 15 Minuten warten – gesperrt wird nur das betroffene Konto |
