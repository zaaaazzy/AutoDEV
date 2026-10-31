# CI (GitHub Actions)

Workflow: `.github/workflows/ci.yml`. Läuft bei `push` auf `main` und bei `pull_request`. Ein Push auf einen anderen Branch startet keinen eigenen Lauf, das übernimmt sein Pull Request. So läuft ein Commit nicht doppelt. Der Workflow hat `permissions: contents: read`, kein Job schreibt ins Repository.

`concurrency` gruppiert nach Workflow und Pull-Request-Nummer bzw. Ref. Ein neuer Push auf denselben Pull Request bricht den laufenden Lauf ab. Läufe auf `main` werden nicht abgebrochen (`cancel-in-progress` nur bei `pull_request`).

## Jobs

```mermaid
flowchart TB
  T(["push auf main oder pull_request"]):::person --> C1
  T --> E1
  T --> D1
  subgraph C["Job check"]
    C1["Postgres 17 als Service"] --> C2["npm ci"] --> C3["lint · format:check · typecheck"] --> C4["test:unit<br/>ohne UI-Build,<br/>DB-Tests Pflicht"]
  end
  subgraph E["Job e2e"]
    E1["Postgres 17 · Chromium"] --> E2["build:ui"] --> E3["test:e2e<br/>Traces bei Fehlern<br/>(7 Tage)"]
  end
  subgraph D["Job docker"]
    D1["zufällige Passwörter"] --> D2["compose build dev-log frontend https<br/>build deploy/review · aideation-agent"] --> D3["sandbox-docker.test.ts<br/>mit echtem Docker"] --> D4["up --wait db dev-log frontend<br/>curl /health · worker + watchdog"] --> D5["down -v"]
  end
  C4 --> OK(["grün: Merge erlaubt"]):::ok
  E3 --> OK
  D5 --> OK
  classDef ok fill:#e3f1e8,stroke:#2f8a57,color:#1d4d33
  classDef person fill:#e8eef6,stroke:#36608f,color:#1f3a5c
```

Alle `actions/checkout`-Schritte nutzen `persist-credentials: false`: Das `GITHUB_TOKEN` landet nicht in `.git/config`, Projektcode (Tests, Testserver, Docker-Build) kann es nicht lesen. Kein Job nutzt Secrets.

- **`check`**: Postgres 17 als Service (`DEV_LOG_TEST_REQUIRE_DATABASE=1`: Datenbank-Tests dürfen nicht übersprungen werden), `npm ci`, `lint`, `format:check`, `typecheck` (inkl. Tests), `npm run test:unit`. `test:unit` baut die Oberfläche nicht, kein Unit-Test liest `dist/ui`. `npm test` (= `build:ui` + `test:unit`) bleibt der lokale Komplettlauf. Die Oberfläche baut in der CI nur der Job `e2e`.
- **`e2e`**: Postgres 17 als Service (Wegwerf-Datenbank, kein Secret), Chromium installieren, `build:ui`, `npm run test:e2e`. Der Playwright-Reporter ist in der CI `list` plus `github`, Fehler stehen also im Log und als Annotation. Bei Fehlern werden die Traces als Artefakt `playwright-traces` (7 Tage) hochgeladen.
- **`docker`**:
  1. Zufällige, maskierte Werte für `DEV_LOG_PASSWORD` und `DEV_LOG_DB_PASSWORD` (sonst griffe das bekannte Standardpasswort aus compose).
  2. `docker compose build dev-log frontend https` (Caddy wird nur gebaut, nicht gestartet), `docker build deploy/review` und `docker build -t aideation-agent -f deploy/agent/Dockerfile .`.
  3. `src/core/sandbox-docker.test.ts` mit echtem Docker (`DEV_LOG_TEST_REQUIRE_DOCKER=1`).
  4. `up -d --wait` für `db`, `dev-log`, `frontend`, dann `curl /health` auf Port 3100; danach `--profile worker up -d --build --wait` für `worker` und `watchdog`.
  5. Bei Fehlern `docker compose logs` (db, dev-log, frontend, worker, watchdog) im Log, am Ende immer `down -v`.

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

- Die CI misst keine Abdeckung und hat bewusst keine Coverage-Schwelle; der Worker misst sie selbst (`src/runner/measured-coverage.ts`).
- Neue Test-Dateien müssen typsicher sein, sonst schlägt `typecheck` in der CI fehl.
- **Actions noch per Tag statt SHA gepinnt** (`actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4`). Die Commit-SHAs ließen sich in der Agent-Umgebung nicht ermitteln (kein Netzzugriff), geraten wird nicht. Nachtragen mit `git ls-remote --tags https://github.com/actions/<name>`, dann `uses: actions/<name>@<sha> # v4.x.y`.
- Die Standard-Testbefehle des Runners (`npm run build` + `npm test`) gelten für alle Projekte und bleiben unverändert, denn andere Projekte haben kein Skript `test:unit`. Für AIdeation selbst in den Projekteinstellungen unter „Testbefehle“ `npm run build` und `npm run test:unit` eintragen, sonst baut der Lauf die Oberfläche zweimal.
