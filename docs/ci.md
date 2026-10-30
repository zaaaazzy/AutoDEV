# CI (GitHub Actions)

Workflow: `.github/workflows/ci.yml`. Läuft bei `push` auf `main` und bei `pull_request`. Ein Push auf einen anderen Branch startet keinen eigenen Lauf, das übernimmt sein Pull Request. So läuft ein Commit nicht doppelt. Der Workflow hat `permissions: contents: read`, kein Job schreibt ins Repository.

`concurrency` gruppiert nach Workflow und Pull-Request-Nummer bzw. Ref. Ein neuer Push auf denselben Pull Request bricht den laufenden Lauf ab. Läufe auf `main` werden nicht abgebrochen (`cancel-in-progress` nur bei `pull_request`).

## Jobs

Alle `actions/checkout`-Schritte nutzen `persist-credentials: false`: Das `GITHUB_TOKEN` landet nicht in `.git/config`, Projektcode (Tests, Testserver, Docker-Build) kann es nicht lesen. Kein Job nutzt Secrets.

- **`check`**: `npm ci`, `lint`, `format:check`, `typecheck` (inkl. Tests), `npm run test:unit`. `test:unit` baut die Oberfläche nicht, kein Unit-Test liest `dist/ui`. `npm test` (= `build:ui` + `test:unit`) bleibt der lokale Komplettlauf. Die Oberfläche baut in der CI nur der Job `e2e`.
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
- **Roter Job `check` heisst nicht immer `test:unit`:** `lint` und `format:check` laufen im selben Job. Vor dem Abschluss alle drei lokal ausführen. Prettier prüft nur `src` und `frontend/src`, nicht `scripts/`. Beispiel: [ci-lint-und-format-fehler-788ec856-2026-10-29.md](ci-lint-und-format-fehler-788ec856-2026-10-29.md).
- **`tsc`/`tsx: not found` im Agent-Container ist kein Testfehler:** Das `node_modules`-Volume des Projekts ist dann leer. Der Worker füllt es vor dem Lauf selbst (`npm ci --ignore-scripts` in einem eigenen Container, Stempel `.aideation-lock` mit dem Lockfile-Hash in `src/core/sandbox.ts`). Vorher ersetzt `prepareModulesMountpoint` im Agent-Worktree den `node_modules`-Symlink auf den Host-Pfad durch einen leeren Ordner (nur im Git-Worktree, das Ziel des Links bleibt unberührt), damit das Volume dort eingebunden wird. Dafür muss der Worker mit dem neuen Code neu gestartet sein. Das Image `aideation-agent` wird beim Neustart neu gebaut. Ein Bug gilt erst nach einem grünen GitHub-Actions-Lauf (Jobs `check` und `docker`) als behoben.
- Neue Test-Dateien müssen typsicher sein, sonst schlägt `typecheck` in der CI fehl.
- **Actions noch per Tag statt SHA gepinnt** (`actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4`). Die Commit-SHAs ließen sich in der Agent-Umgebung nicht ermitteln (kein Netzzugriff), geraten wird nicht. Nachtragen mit `git ls-remote --tags https://github.com/actions/<name>`, dann `uses: actions/<name>@<sha> # v4.x.y`.
- Die Standard-Testbefehle des Runners (`npm run build` + `npm test`) gelten für alle Projekte und bleiben unverändert, denn andere Projekte haben kein Skript `test:unit`. Für AIdeation selbst in den Projekteinstellungen unter „Testbefehle“ `npm run build` und `npm run test:unit` eintragen, sonst baut der Lauf die Oberfläche zweimal.
