# CI (GitHub Actions)

Workflow: `.github/workflows/ci.yml`. Läuft bei `push` und `pull_request`. Der Workflow hat `permissions: contents: read`, kein Job schreibt ins Repository.

## Jobs

Alle `actions/checkout`-Schritte nutzen `persist-credentials: false`: Das `GITHUB_TOKEN` landet nicht in `.git/config`, Projektcode (Tests, Testserver, Docker-Build) kann es nicht lesen. Kein Job nutzt Secrets.

- **`check`**: `npm ci`, `lint`, `format:check`, `typecheck` (inkl. Tests), `npm test`.
- **`e2e`**: Postgres 17 als Service (Wegwerf-Datenbank, kein Secret), Chromium installieren, `build:ui`, `npm run test:e2e`. Der Playwright-Reporter ist in der CI `list` plus `github`, Fehler stehen also im Log und als Annotation. Bei Fehlern werden die Traces als Artefakt `playwright-traces` (7 Tage) hochgeladen.
- **`docker`**:
  1. Zufällige, maskierte Werte für `DEV_LOG_PASSWORD` und `DEV_LOG_DB_PASSWORD` (sonst griffe das bekannte Standardpasswort aus compose).
  2. `docker compose build dev-log frontend https` (Caddy wird nur gebaut, nicht gestartet) und `docker build deploy/review`.
  3. `up -d --wait` für `db`, `dev-log`, `frontend`, dann `curl /health` auf Port 3100.
  4. Bei Fehlern `docker compose logs` (db, dev-log, frontend) im Log, am Ende immer `down -v`.

## Typprüfung der Tests

`npm run typecheck` prüft jetzt vier Konfigurationen:

- `tsconfig.json` (Backend) und `frontend/tsconfig.app.json` (Oberfläche) wie bisher.
- `tsconfig.test.json` (neu): `src/**`, `e2e/**`, `scripts/**` inklusive Test-Dateien, `--noEmit`.
- `frontend/tsconfig.spec.json` (neu): Frontend-Specs.

`tsx` prüft keine Typen. Ohne diese Konfigurationen fielen Typfehler in Tests nie auf. Die dabei gefundenen Fehler wurden im Code behoben, nicht per `any`, `@ts-ignore` oder Ausnahme in der tsconfig.

## Weitere Änderungen

- Lint: die 2 `no-regex-spaces`-Fehler sind im Code behoben (0 Fehler). Die rund 370 Warnungen sind nicht Teil dieses Auftrags.
- `.dockerignore` geprüft: kein `.env` und keine Zugangsdaten im Build-Kontext.
- `e2e/full.config.ts`, `e2e/playwright.config.ts` (CI-Reporter), `e2e/app.spec.ts`, `README.md` angepasst.
- Nach dem Merge von `main` kamen 2 neue Typfehler in Tests dazu (`src/api/agents.test.ts`, `frontend/src/app/shared/role-icon.spec.ts`); beide sind im Code behoben.

## Worauf zu achten ist

- **Noch nicht in GitHub Actions belegt:** Lokal grün sind Typprüfung, Lint, Format, `npm test` (870/870), E2E (58 bestanden, 2 nur auf dem Handy übersprungen) und der Compose-Build von `dev-log`, `frontend`, `https`. Nicht lokal geprüft sind `docker build deploy/review` (der Wächter erlaubt nur `docker compose`) und der Containerstart mit Health-Prüfung (der feste `container_name` würde die Produktiv-Container ersetzen). Den Auftrag erst nach dem ersten grünen CI-Lauf von `e2e` und `docker` als erledigt führen.
- Die Testabdeckung wird nicht gemessen (der Wächter blockiert `--experimental-test-coverage`, Werte bleiben `null`). Es gibt bewusst keine Coverage-Schwelle in der CI.
- Neue Test-Dateien müssen typsicher sein, sonst schlägt `typecheck` in der CI fehl.
