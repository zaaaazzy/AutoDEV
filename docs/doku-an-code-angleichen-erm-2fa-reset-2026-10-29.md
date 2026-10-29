# Doku an den Code angleichen (ERM, 2FA-Reset, Wartungs-Jobs, DEV_LOG_BIND)

Auftrag 59c9e471 (Dokumentation) aus dem Code-Review vom 21.10.2026 (Stand `a4971e9`). Stand: 29.10.2026. Sprint 28.

## Problem
Mehrere Dokumente beschrieben einen alten Stand. Wer nach Doku handelte (2FA zurücksetzen, Erreichbarkeit einschränken), erreichte nichts.

## Was umgesetzt wurde
- **`docs/erm.md`** aus `src/db/schema.ts` ergänzt:
  - Neue Abschnitte „Anmeldung, Benutzer und Mandanten“ (`app_settings`, `users`, `auth_sessions`, `push_subscriptions`, `project_members`, `doc_revisions`) und „Review-Container, Budgets und Modell-Routing“ (`review_slots`, `budgets`, `budget_warnings`, `budget_role_limits`, `routing_rules`).
  - Neue Status-Werte: Bugs `rejected`; Sprints `review` und `cancelled`; Aufträge `approval` und `rejected`.
- **`README.md`:** Der 2FA-Reset unterscheidet jetzt zwei Fälle.
  - Systemadministrator (Anmeldung aus `.env`): `app_settings.auth_totp_secret` und `auth_totp_pending` löschen, danach `docker compose restart dev-log`.
  - Benannte Benutzer: Schlüssel liegt in `users.totp_secret`. Ein Administrator setzt ihn über `POST /api/users/<id>/totp/reset` zurück (Einstellungen → Alle Projekte → Benutzer & Rollen), sonst per `UPDATE users SET totp_secret = NULL, totp_pending = NULL …`. Kein Neustart nötig.
- **`docs/wartungs-jobs.md`:** Die alte Lint-Meldung ist ersetzt: `npm run lint` läuft ohne Fehler (nur Warnungen).
- **`docs/laufzeit.md`:** „Stand: 19.10.2026“ ersetzt durch den Hinweis auf Erstfassung und laufende Nachführung. Die 520 Zeilen wurden nicht vollständig gegen den Code geprüft, deshalb steht kein neues Prüfdatum darin.
- **`DEV_LOG_BIND` entfernt** (nicht zur echten Adresse umgebaut): Die Variable hatte keine Wirkung, nur einen Warnblock in `src/server.ts`.
  - `src/server.ts`: Warnblock gelöscht, sonst keine Logik geändert.
  - `docker-compose.yml`: Zeile entfernt, Kommentar bei `DEV_LOG_HOST: 0.0.0.0` erklärt, dass der Dienst nur im Compose-Netz lauscht.
  - Die Listen-Adresse steuert weiterhin nur `DEV_LOG_HOST` (ohne Container 127.0.0.1, im Container 0.0.0.0).

## Worauf zu achten ist
- Die `.env` des Live-Systems (für Agents gesperrt) kann noch `DEV_LOG_BIND` enthalten. Der Eintrag ist harmlos, wirkt aber nicht. Bei Gelegenheit entfernen.
- `docs/bug-suche-2026-10-20.md` ist ein datierter Bericht und nennt `DEV_LOG_BIND` weiterhin als Momentaufnahme.
- Neue Tabellen oder Status-Werte in `schema.ts` gehören auch in `docs/erm.md`.

## Tests
Laut Entwickler liefen die Unit-Tests vor und nach der Änderung grün (1809/1809). Für diese Dokumentation wurden sie nicht erneut ausgeführt.

## Geänderte Dateien
- `README.md`
- `docker-compose.yml`
- `src/server.ts`
- `docs/erm.md`
- `docs/laufzeit.md`
- `docs/wartungs-jobs.md`
