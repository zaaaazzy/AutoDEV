# Skripte lesen .env statt auf das Standard-Passwort zurückzufallen

Auftrag 3027e27e (Bugfix, Sprint 23). Aus dem Code-Review vom 21.10.2026 (Stand `a4971e9`).

## Problem

Der Einrichtungs-Assistent setzt per `ALTER USER` ein zufälliges DB-Passwort. Worker, Wächter, Installationsskripte, E2E und Review-Skript fielen aber still auf `devlog_local_dev` zurück, wenn die Variable in der Umgebung fehlte. `install-watchdog.sh` in einer frischen Shell schrieb so das alte Passwort in die Plist; Worker und Wächter scheiterten an der Anmeldung, und der Wächter konnte nicht einmal per Push melden.

## Umsetzung

- **Ein gemeinsamer `.env`-Leser** (`src/core/local-database.ts`, nutzt `parseEnv` aus `env-file.ts`):
  - `envFilePath` / `readEnvValues`: `.env` der Installation, in einem Git-Worktree ohne eigene `.env` die des Hauptordners.
  - `loadInstallEnv(root)`: übernimmt nur `INSTALL_ENV_KEYS` (DB-URLs, Secret-Key, Public-URL, Domain, Projekt-Roots) in die Umgebung. Schon gesetzte Werte bleiben, die Umgebung hat Vorrang. Eine fehlende `.env` ist kein Fehler. `DEV_LOG_PASSWORD` (Oberfläche) wird bewusst nicht übernommen, damit Agents es nicht erben.
  - `requireDatabaseUrl()`: wirft mit klarer Meldung, wenn `DEV_LOG_DATABASE_URL` fehlt.
  - `localDatabaseUrl()`: wirft ohne `DEV_LOG_DB_PASSWORD`; Standardpasswort nur mit `DEV_LOG_ALLOW_DEFAULT_DB_PASSWORD=1` (Wegwerf-Umgebung).
- **Worker und Wächter** (`runner-cli.ts`, `watchdog-cli.ts`) laden die `.env` selbst; `push.ts` nutzt denselben Leser statt eines eigenen.
- **Shell-Skripte** (`scripts/lib/service-env.sh`): neuer `dotenv_get` liest mit denselben Regeln wie `parseEnv`. Reihenfolge in `resolve_value`: Umgebung, `.env` der Installation, Env-Datei des Dienstes. `warn_default_password` wurde zu `require_database_url`: Abbruch (Exit 1) bei fehlender URL oder Standardpasswort.
- Angepasst: `install-watchdog.sh`, `install-worker.sh`, `install-worker-linux.sh`, `install-worker.ps1`, `restore.sh`, `seed-demo.ts`, `scripts/test-full.ts`.
- **E2E**: `e2e/admin-url.ts` (neu) liefert die Admin-URL ohne Standardwert; `playwright.config.ts`, `git-zustand.spec.ts`, `full-ui.check.ts`, `aufklappen.spec.ts` nutzen sie. Die Config importiert nichts, was `@playwright/test` mitbringt.
- **Doku**: `docs/installation.md`, `docs/benutzerhandbuch-dashboard-agents.md` (Abbruch statt Warnung).

## Tests

`npm test`: 1604 von 1604 grün. Neu bzw. angepasst:
- `src/setup/install-scripts.test.ts`: Installationsskripte ohne URL brechen ab, `.env` hat Vorrang vor der Dienst-Env-Datei, `dotenv_get` liest wie `parseEnv`. Die frühere Erwartung des Standardpassworts (Zeile 93) wurde bewusst geändert.
- `src/core/local-database.test.ts`, `src/db/test-database.test.ts`.

Nicht geprüft: E2E-Läufe, `install-worker.ps1` (kein pwsh vorhanden).

## Geänderte Dateien

docs/benutzerhandbuch-dashboard-agents.md, docs/installation.md, e2e/admin-url.ts, e2e/aufklappen.spec.ts, e2e/full-ui.check.ts, e2e/git-zustand.spec.ts, e2e/playwright.config.ts, scripts/install-watchdog.sh, scripts/install-worker-linux.sh, scripts/install-worker.ps1, scripts/install-worker.sh, scripts/lib/service-env.sh, scripts/restore.sh, scripts/seed-demo.ts, scripts/test-full.ts, src/core/local-database.ts, src/core/local-database.test.ts, src/core/push.ts, src/db/test-database.test.ts, src/runner/runner-cli.ts, src/runner/watchdog-cli.ts, src/setup/install-scripts.test.ts

## Worauf zu achten ist

- **Verhaltensänderung:** Installationsskripte brechen jetzt ab statt zu warnen. Wer bewusst mit dem Standardpasswort arbeitet, setzt `DEV_LOG_ALLOW_DEFAULT_DB_PASSWORD=1`. Vorher `./start.sh --setup` ausführen, das schreibt die `.env`.
- `push.ts` und `runner-cli.ts` weichen absichtlich vom Prettier-Format ab (`npm run format:check` meldet sie) – nicht neu formatieren.
- `deploy/review/aideation-review.sh` stand im Auftrag, erscheint aber nicht in der Liste der geänderten Dateien. Prüfen, ob das `sed` dort noch durch den gemeinsamen Leser ersetzt werden muss.
- Neue Skripte, die die `.env` brauchen, nutzen `loadInstallEnv` bzw. `dotenv_get`, keinen eigenen Parser.
- Die Compose-Datei bleibt unverändert (nicht Teil des Auftrags).

## Sprint 23 / Anfrage-TODO

- Auftrag 3027e27e: Bugfix, umgesetzt, Tests grün (`npm test`), Dokumentation hier.
- Offen: E2E-Lauf und PowerShell-Skript manuell prüfen; Review-Skript (`deploy/review/aideation-review.sh`) gegenprüfen.
