# CI (GitHub Actions)

Workflow: `.github/workflows/ci.yml`. Läuft bei `push` und `pull_request`. Der Workflow hat `permissions: contents: read`, kein Job schreibt ins Repository.

## Jobs

| Job      | Inhalt                                                                                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check`  | `npm ci`, `lint`, `format:check`, `typecheck` (inkl. Tests), `npm test`                                                                                                                         |
| `e2e`    | Postgres 17 als Service, Chromium installieren, `build:ui`, `npm run test:e2e`. Bei Fehlern werden Playwright-Traces als Artefakt `playwright-traces` (7 Tage) hochgeladen.                      |
| `docker` | `docker compose build dev-log frontend`, dann `up -d --wait` für `db`, `dev-log`, `frontend` und `curl /health` auf Port 3100. Das Passwort wird zufällig erzeugt und maskiert. Am Ende `down -v`. |

Der Dienst mit Caddy/https (Profil) wird in der CI nicht gebaut.

## Typprüfung der Tests

`npm run typecheck` prüft jetzt vier Konfigurationen:

- `tsconfig.json` (Backend) und `frontend/tsconfig.app.json` (Oberfläche) wie bisher.
- `tsconfig.test.json` (neu): `src/**`, `e2e/**`, `scripts/**` inklusive Test-Dateien, `--noEmit`.
- `frontend/tsconfig.spec.json` (neu): Frontend-Specs.

`tsx` prüft keine Typen. Ohne diese Konfigurationen fielen Typfehler in Tests nie auf. Die dabei gefundenen Fehler wurden im Code behoben, nicht per `any`, `@ts-ignore` oder Ausnahme in der tsconfig.

## Weitere Änderungen

- Lint: die 2 `no-regex-spaces`-Fehler sind im Code behoben (0 Fehler). Die rund 370 Warnungen sind nicht Teil dieses Auftrags.
- `.dockerignore` geprüft: kein `.env` und keine Zugangsdaten im Build-Kontext.
- `e2e/full.config.ts`, `e2e/app.spec.ts`, `README.md` angepasst.

## Worauf zu achten ist

- **Noch nicht in GitHub Actions belegt:** Die Jobs `e2e` und `docker` liefen bisher nur lokal (Build, E2E: 48 bestanden, 2 nur auf dem Handy übersprungen). Der Containerstart mit Health-Prüfung lief lokal nicht, weil der feste `container_name` die Produktiv-Container ersetzt hätte. Den Auftrag erst nach dem ersten grünen CI-Lauf als erledigt führen.
- `npm test` war einmal mit 1 von 818 Tests rot (Test unbekannt), danach zweimal grün. Vermutlich unzuverlässiger Test bei parallelem Lauf mit Lint. Bei erneutem Auftreten den Test benennen.
- Die Testabdeckung wurde nicht gemessen (der Wächter blockiert `--experimental-test-coverage`).
- Neue Test-Dateien müssen typsicher sein, sonst schlägt `typecheck` in der CI fehl.
