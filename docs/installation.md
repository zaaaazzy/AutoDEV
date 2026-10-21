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

## Fehlerbehebung

| Problem | Lösung |
|---|---|
| „Docker läuft nicht“ | Docker Desktop starten, dann erneut `./start.sh` |
| Seite lädt nicht | `docker compose logs dev-log` – meist fehlt `DEV_LOG_PASSWORD` (mind. 16 Zeichen) in `.env` |
| Agents starten nicht | Worker-Status oben in AIdeation prüfen; `npm run worker` zeigt Fehler direkt |
| Zwei-Faktor-Gerät verloren | siehe README, Abschnitt Sicherheit |
| Zu viele Fehlversuche | 15 Minuten warten – gesperrt wird nur das betroffene Konto |
