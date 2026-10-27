# Container härten und Logs rotieren (2026-10-27)

Auftrag `57f7ff3c-2de3-4ca8-98d1-8ed1f7cf1594` (Sprint 23). Aus dem Code-Review vom 21.10.2026 (Stand `a4971e9`).

## Problem

Der nginx-Master lief als root, kein Dienst hatte `cap_drop`, `no-new-privileges` oder `read_only`, `backup` und
`https` hatten keinen Healthcheck. Das gemeinsame npm-Cache-Volume des Review-Containers ließ sich von einem Projekt für
alle vergiften. Worker- und Wächter-Log wuchsen ohne Grenze.

## Umsetzung

- **Compose** (`docker-compose.yml`): Alle Dienste haben `no-new-privileges:true` und `cap_drop: [ALL]`. Zurückgegeben
  wird nur Begründetes: `db` bekommt `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID` (Entrypoint übergibt das
  Datenverzeichnis an `postgres` und wechselt den Benutzer), `https` `NET_BIND_SERVICE`, `https-volumes` `CHOWN` und
  `DAC_OVERRIDE`. `frontend`, `https`, `backup` und `https-volumes` laufen mit `read_only: true`, `/tmp` als `tmpfs`
  (bei `https-volumes` ohne tmpfs). `dev-log` und `db` bleiben beschreibbar (Anhänge, Doku, Daten).
- **nginx** (`deploy/frontend/Dockerfile`): Basis `nginxinc/nginx-unprivileged:1.27.3-alpine` statt `nginx` mit
  `sed`-Umbau. Der Master läuft als `nginx`, die Ports 8080/8081 bleiben.
- **Review-Container:** `USER node` und ein npm-Cache-Volume je Projekt (`aideation_review_npm_<Slug>` unter
  `/home/node/.npm`, `reviewNpmVolume` in `src/runner/review-slots.ts`) waren schon vorhanden und wurden nicht
  geändert. Verweise auf `/root/.npm` gibt es nicht mehr.
- **Log-Rotation (macOS):** `install_log_rotation` in `scripts/lib/service-env.sh` legt idempotent
  `/etc/newsyslog.d/aideation-worker.conf` (10 MB, 5 Stände) und `aideation-watchdog.conf` (1 MB, 3 Stände) an
  (per sudo, `root:wheel`, 644; Flags `NJ`). Pfade mit Leerzeichen: Warnung, keine Regel. Sudo abgelehnt: Installation
  läuft weiter.
- **Worker schreibt sein Log selbst:** `followLogFile` (`src/core/log-file.ts`) hängt stdout/stderr an
  `DEV_LOG_LOG_FILE` und öffnet die Datei nach der Rotation binnen 10 s neu (Inode-Vergleich). Sonst zeigte der
  launchd-Deskriptor weiter auf die umbenannte Datei und das aktuelle Log, das die Fehlersuche liest, stünde in `.0`.
  `install-worker.sh` setzt die Variable in der Plist, `runner-cli.ts` ruft die Funktion in `main()` auf.
- **Autofix:** Neuer Test, dass `EROFS`, `EACCES` und `EPERM` weder als Umgebungs- noch als Agent-Fehler gelten (keine
  Endlosschleife). `src/runner/autofix.ts` selbst wurde nicht geändert.

## Geänderte Dateien

- `deploy/frontend/Dockerfile`, `docker-compose.yml`
- `scripts/install-worker.sh`, `scripts/install-watchdog.sh`, `scripts/lib/service-env.sh`
- `src/core/log-file.ts`, `src/runner/runner-cli.ts`
- `src/core/log-file.test.ts`, `src/runner/container-hardening.test.ts`, `src/setup/install-scripts.test.ts`,
  `src/runner/autofix.test.ts`
- `docs/installation.md` (Abschnitte „Container-Härtung“, „Log-Rotation (macOS)“)

## Worauf ist zu achten

- **Nicht mit Docker geprüft** (für Agents gesperrt). Vor dem Merge muss ein Mensch
  `COMPOSE_PROFILES=https docker compose up -d --build` ausführen und prüfen: (1) `db` startet mit den fünf
  Capabilities und bestehende Daten sind lesbar, (2) `frontend` ist gesund (nginx-unprivileged, `read_only`),
  (3) `https` und `backup` laufen mit `read_only`.
- Das alte Volume `aideation_review_npm` ist unbenutzt und kann gelöscht werden.
- Die Install-Skripte wurden nicht ausgeführt; die newsyslog-Regeln entstehen erst beim nächsten Lauf (sudo nötig).
- `npm run format:check` meldet `container-hardening.test.ts`, `install-scripts.test.ts` und `runner-cli.ts`; mit
  Prettier formatieren.

## Tests

Ausführen über `npm test`: `container-hardening.test.ts` (liest Compose und Dockerfile), `log-file.test.ts` (Neuöffnen
nach Rotation), `install-scripts.test.ts` (Regel idempotent über `AIDEATION_NEWSYSLOG_DIR`), `autofix.test.ts`.
