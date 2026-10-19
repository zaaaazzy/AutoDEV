# Dev Log installieren

Dev Log besteht aus drei Teilen:

| Teil | Läuft | Aufgabe |
|---|---|---|
| **Dev Log** (Oberfläche + API) | in Docker | Projekte, Ideen, Aufträge, Sprints, Dokumentation |
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
git clone <repository-url> DevLog
cd DevLog
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

Danach öffnet sich Dev Log unter `http://localhost:3100`. Nach der Anmeldung begrüßt dich Dev Log und bietet an,
das erste Projekt anzulegen.

Bei **späteren Starts** startet `./start.sh` bzw. `start.cmd` nur die Dienste und öffnet Dev Log.
Mit `./start.sh --setup` (Windows: `start.cmd --setup`) öffnest du den Assistenten erneut – die bisherige `.env`
wird vorher gesichert.

## 3. Erstes Projekt und Tour

1. **Projekt erstellen** – der Projekt-Assistent prüft den Ordner, richtet Git/GitHub und auf Wunsch eine Vorlage ein,
   testet die Agent-Verbindung und legt die Rechte der Agents fest.
2. **Tour starten** – danach (oder jederzeit unter **Hilfe → Interaktive Tour**) führt dich Dev Log Schritt für Schritt:
   - **Ideation**: Idee erfassen, Auftrag vom Auftragsautor erstellen lassen
   - **Auftrag**: Aufträge direkt anlegen, „In Entstehung“ und „Besondere Aufmerksamkeit“
   - **Sprint**: Sprint anlegen, im **Board** Aufträge von „Offen“ nach „Geplant“ ziehen –
     die Reihenfolge bestimmt, was die Agents zuerst abarbeiten
   - **Sprint starten** und dem ersten Agent live zuschauen

Ausprobierte Projekte lassen sich unter **Einstellungen → Projekt löschen** wieder entfernen – auf Wunsch samt
Ordner auf deinem Rechner.

## Zugriff von unterwegs (optional)

Mit eigener Domain im Assistenten startet zusätzlich der Dienst `https` (Caddy) und holt automatisch ein
Let's-Encrypt-Zertifikat. Dafür muss dein Router **Port 443** (TCP) an diesen Rechner weiterleiten und die Domain
auf deine öffentliche IP zeigen. Dev Log ist dann installierbar als App (Handy: „Zum Home-Bildschirm“) und schickt
Push-Nachrichten.

## Nützliche Befehle

```bash
docker compose ps                 # Zustand der Dienste
docker compose logs -f dev-log    # Protokoll von Dev Log
npm run worker                    # Worker im Vordergrund starten (ohne Autostart)
./start.sh --setup                # Einrichtung wiederholen
```

Die Container heissen `devlog_database_postgres` (Datenbank), `devlog_backend_nodejs` (API und Oberfläche),
`devlog_backup_postgres` (tägliche Sicherung) und `devlog_proxy_caddy` (HTTPS, optional). In den Befehlen oben
stehen die Dienstnamen (`db`, `dev-log`, `backup`, `https`); `docker exec` braucht den Containernamen, z. B.
`docker exec -it devlog_database_postgres psql -U devlog dev_log`.

## Fehlerbehebung

| Problem | Lösung |
|---|---|
| „Docker läuft nicht“ | Docker Desktop starten, dann erneut `./start.sh` |
| Seite lädt nicht | `docker compose logs dev-log` – meist fehlt `DEV_LOG_PASSWORD` (mind. 16 Zeichen) in `.env` |
| Agents starten nicht | Worker-Status oben in Dev Log prüfen; `npm run worker` zeigt Fehler direkt |
| Zwei-Faktor-Gerät verloren | siehe README, Abschnitt Sicherheit |
| Zu viele Fehlversuche | 15 Minuten warten – gesperrt wird nur das betroffene Konto |
