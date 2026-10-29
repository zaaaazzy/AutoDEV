# TOTP- und VAPID-Schlüssel verschlüsselt speichern (2026-10-27)

## Problem

Aus dem Code-Review vom 21.10.2026: `encryptSecret` schützte nur `projects.database_url`. Wer einen Dump hatte, konnte
mit dem privaten VAPID-Schlüssel (`app_settings.push_vapid_keys`) Push-Nachrichten als AIdeation senden.

## Stand

- **TOTP** war schon umgestellt: `sealTotp`/`openTotp` und `sealStoredTotpSecrets` in `src/api/auth.ts` (Benutzer und
  Systemadministrator, aktiv und ausstehend). Klartext gilt nach dem Start als Fehler.
- **VAPID** ist mit diesem Auftrag umgestellt (`src/core/push.ts`):
  - `vapidKeys` schreibt neue Schlüssel nur mit `sealVapid` (Präfix `enc:v1:`). Ohne `DEV_LOG_SECRET_KEY` wird nichts
    geschrieben (`VapidKeyMissingError`), Push meldet dann nur einen Fehler im Log.
  - Lesen über `openVapid`: Verschlüsseltes wird entschlüsselt. Klartext aus der Zeit davor bleibt lesbar, bis der
    Server ihn beim Start umstellt (Worker oder Wächter können vorher laufen).
  - `sealStoredVapidKeys` läuft in `src/server.ts` nach den TOTP-Schlüsseln. Es verschlüsselt Klartext einmal
    (idempotent, `UPDATE … AND value = <alter Wert>`). Es bricht den Start ab, wenn ein Schlüssel gespeichert ist, aber
    `DEV_LOG_SECRET_KEY` fehlt oder nicht passt. Gelöscht wird dabei nichts. Der Schlüssel selbst bleibt gleich, die
    Push-Abos der Geräte gelten weiter.
- Der Entschlüsselungs-Test beim Restore (`src/db/secret-key-check.ts`) prüft jetzt auch `push_vapid_keys`.
- `scripts/install-watchdog.sh` schreibt `DEV_LOG_SECRET_KEY` in `watchdog.env`, weil der Wächter den Push-Schlüssel
  lesen muss. Bestehende Installationen: Skript einmal mit `DEV_LOG_SECRET_KEY=…` erneut ausführen. Bis dahin nutzt der
  Wächter die zwischengespeicherten Schlüssel aus seiner Zustandsdatei.

## Grenzen

- Der Wächter speichert die VAPID-Schlüssel weiter im Klartext in
  `~/Library/Application Support/DevLog/watchdog.json` (Rechte 600), damit er auch bei ausgefallener Datenbank melden
  kann. Die Datei liegt nicht im Datenbank-Backup.
- Verschlüsselt sind nur Projektzugänge, TOTP- und VAPID-Schlüssel. Der Rest des Dumps ist lesbar (README, Abschnitt
  Backups; `docs/installation.md`, Wiederherstellen).

## Tests

- `src/core/push.test.ts`: neue Schlüssel nur verschlüsselt, ohne Schlüssel nichts geschrieben, Umstellung beim Start
  einmalig und mit gleichem Schlüssel, Abbruch ohne oder mit falschem Schlüssel ohne Datenverlust.
- `src/api/push.test.ts`: auf PostgreSQL liegt `push_vapid_keys` nach `GET /push/key` mit Präfix `enc:v1:` vor.
- Ausführen über `npm test`.
