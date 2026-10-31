# Benutzerhandbuch: Container härten und Logs rotieren

Gilt ab Sprint 23 (Auftrag 57f7ff3c). Betrifft `docker-compose.yml`, die Images von `frontend` (nginx) und dem Review-Container, die Installationsskripte für macOS (`scripts/install-worker.sh`, `scripts/install-watchdog.sh`) und den Worker (`src/core/log-file.ts`).

## Was sich ändert

**Container:**

- Alle Dienste laufen mit `no-new-privileges` und ohne Linux-Capabilities (`cap_drop: [ALL]`). Nur `db`, `https` und der einmalige Dienst `https-volumes` bekommen wenige Capabilities zurück, jeweils mit Begründung (siehe unten).
- `frontend` läuft auf `nginxinc/nginx-unprivileged`. Auch der nginx-Master läuft als Benutzer `nginx`, nicht als root. Die Ports im Container sind 8080 (direkter Zugriff) und 8081 (nur Caddy).
- `frontend`, `https` und `backup` haben ein schreibgeschütztes Dateisystem (`read_only`). Beschreibbar sind nur `/tmp` (tmpfs) und die eigenen Volumes.
- `dev-log`, `frontend`, `backup` und `https` haben einen Healthcheck. Die laufenden Dienste haben Grenzen für Speicher, CPU und Prozesse.
- Der Review-Container läuft als Benutzer `node`. Jedes Projekt hat sein eigenes npm-Cache-Volume. Ein Projekt kann den Cache eines anderen nicht mehr vergiften.

**Logs (nur macOS):**

- Das Worker-Log und das Wächter-Log werden rotiert. Bisher wuchsen sie ohne Grenze.
- Der Worker schreibt sein Log selbst. Nach einer Rotation öffnet er die Datei neu, das aktuelle Log bleibt also unter dem bekannten Namen lesbar.

Eine Oberfläche gibt es für diese Änderung nicht. Deshalb gibt es **keine Printscreens**. Die Änderungen zeigen sich in `docker compose ps`, im Ordner `~/Library/Logs/` und in `/etc/newsyslog.d/`.

## Bedingungen

### Container-Härtung

- Die Änderungen wirken erst nach einem Neubau. Führe `docker compose up -d --build` aus. Ein einfaches Neustarten reicht nicht.
- Der Dienst `db` darf nicht `read_only` sein. Er schreibt seine Daten. Auch `dev-log` bleibt beschreibbar, weil er Anhänge und Doku zur Laufzeit speichert.
- Das frühere gemeinsame npm-Cache-Volume `aideation_review_npm` wird nicht mehr benutzt. Du kannst es mit `docker volume rm aideation_review_npm` löschen. Es ist kein Datenverlust, der Cache baut sich neu auf.

Die Capabilities, die zurückkommen, und der Grund dafür:

| Dienst | Capabilities | Grund |
|---|---|---|
| `db` | `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID` | Der Entrypoint übergibt das Datenverzeichnis an `postgres` und wechselt dann zu diesem Benutzer. |
| `https` | `NET_BIND_SERVICE` | Caddy bindet die Ports 80 und 443. |
| `https-volumes` | `CHOWN`, `DAC_OVERRIDE` | Übergibt bestehende Zertifikats-Volumes einmalig an `caddy`. Der Dienst beendet sich danach. |

### Log-Rotation (macOS)

- Die Regeln liegen in `/etc/newsyslog.d/aideation-worker.conf` (ab 10 MB, 5 Stände) und `/etc/newsyslog.d/aideation-watchdog.conf` (ab 1 MB, 3 Stände). Die alten Stände werden bzip2-komprimiert, etwa `aideation-worker.log.0.bz2`.
- Die Regeln gehören `root:wheel`. Das Installationsskript fragt dafür einmal nach dem sudo-Passwort.
- Ein erneuter Lauf des Skripts schreibt die Regel nur, wenn sie fehlt oder sich geändert hat. Sonst meldet es „Log-Rotation unverändert“.
- Lehnst du sudo ab, läuft die Installation trotzdem weiter, nur ohne Rotation. Die Warnung „Log-Rotation nicht eingerichtet (sudo abgelehnt)“ steht dann in der Ausgabe. Führe das Skript später erneut aus.
- Liegt der Log-Pfad in einem Ordner mit Leerzeichen, legt das Skript **keine** Regel an. newsyslog kann solche Pfade nicht lesen. Es erscheint eine Warnung.
- Unter Linux und Windows gibt es keine Rotation für den Worker. Unter Linux rotiert journald das Log.

### Worker-Log

- Der Worker öffnet die Log-Datei nach einer Rotation binnen 10 Sekunden neu. Das gilt nur, wenn die Variable `DEV_LOG_LOG_FILE` gesetzt ist. `install-worker.sh` setzt sie in der Plist.
- Nach dem Neuöffnen steht die aktuelle Ausgabe wieder in `~/Library/Logs/aideation-worker.log`. Der Wächter braucht dafür keinen Neustart.
- Ist die Datei gerade nicht schreibbar, etwa weil die Platte voll ist, verwirft der Worker die Zeile und läuft weiter.

## Was du siehst

### Container

| Prüfung | Erwartung |
|---|---|
| `docker compose ps` | Alle Dienste `healthy` oder `running`. |
| `docker compose logs frontend` | Keine Meldung über fehlende Rechte oder Schreibfehler für `/var/cache/nginx` oder die PID-Datei. |
| `docker inspect aideation_frontend_angular --format '{{.HostConfig.ReadonlyRootfs}}'` | `true` |

Schlägt `frontend` nach dem Neubau fehl, ist meist ein Pfad außerhalb von `/tmp` schreibbar zu machen. Das Log des Containers nennt den Pfad.

### Log-Rotation

Die Regel ist eine einfache Textdatei. Prüfen kannst du sie so:

```
cat /etc/newsyslog.d/aideation-worker.conf
```

Die Zeile mit dem Log-Pfad muss `600` und `NJ` enthalten (Rechte 600, bzip2, kein Signal).

Eine Rotation lässt sich mit `sudo newsyslog -F -n` testen, etwa `sudo newsyslog -F -n ~/Library/Logs/aideation-worker.log`. `-F` erzwingt die Rotation auch unterhalb der Größe; `-n` verhindert ein Signal an den Worker. Danach sollte ein `aideation-worker.log.0` (komprimiert `.bz2`) auftauchen. Der Worker schreibt innerhalb von 10 Sekunden in die neue Datei. Diese Prüfung ist nicht ausgeführt worden.

## Beispiel

Ein Worker-Log von 10 MB wird rotiert:

1. newsyslog benennt `aideation-worker.log` in `aideation-worker.log.0` um und legt eine leere neue Datei an.
2. Der Worker bemerkt innerhalb von 10 Sekunden, dass sich die Datei geändert hat, und öffnet sie neu.
3. Die nächste Ausgabe landet in der neuen `aideation-worker.log`. Die alte Datei wird als `aideation-worker.log.0.bz2` komprimiert.
4. Nach dem fünften Stand wird der älteste gelöscht.

Zwischen Schritt 1 und 2 geschriebene Zeilen landen in `aideation-worker.log.0`. Sie gehen nicht verloren.

## Offene Punkte

- **Docker ist nicht geprüft.** Der Start der Container mit `read_only` und die Capabilities von `db` sind noch nicht am laufenden Stack bestätigt. Vor dem Merge sollte jemand `COMPOSE_PROFILES=https docker compose up -d --build` ausführen und die Prüfung oben durchgehen. Die bestehenden Daten von `db` müssen lesbar bleiben.
- **Die Install-Skripte wurden nicht ausgeführt.** Die newsyslog-Regeln entstehen erst beim nächsten Lauf mit sudo.
- **Die Tests** (`npm test`) für Container-Härtung, Log-Rotation, Installationsskripte und Autofix sind nicht gelaufen.
- Das alte Volume `aideation_review_npm` ist ungenutzt und kann gelöscht werden.
