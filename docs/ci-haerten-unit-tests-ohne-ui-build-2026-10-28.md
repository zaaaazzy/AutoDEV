# CI härten und Unit-Tests ohne Oberflächen-Build

Auftrag ec898526 (Sprint 23). Aus dem Code-Review vom 21.10.2026 (Stand `a4971e9`).

## Problem

Der CI-Workflow lief bei `[push, pull_request]` und damit jeden Commit auf einem Pull-Request-Branch doppelt. Es gab keine `concurrency`, die Actions sind per Tag statt per SHA gepinnt. `npm test` baute zuerst die Oberfläche im Produktionsmodus, obwohl kein Test `dist/` liest.

`permissions: contents: read` und `persist-credentials: false` standen laut Code-Stand schon im Workflow und wurden nicht neu angelegt.

## Umsetzung

- **Trigger** (`.github/workflows/ci.yml`): `push` nur auf `main`, dazu `pull_request`. Branches laufen über ihren Pull Request.
- **`concurrency`**: Gruppe `${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}`. `cancel-in-progress` gilt nur bei `pull_request`, Läufe auf `main` laufen immer zu Ende.
- **Neues Skript `test:unit`** (`package.json`): `tsx --test` mit denselben drei Globs wie zuvor (`src/**/*.test.ts`, `scripts/**/*.test.ts`, `frontend/src/**/*.spec.ts`).
- **`npm test`** ist jetzt `npm run build:ui && npm run test:unit` (Komplettlauf, gleiche Wirkung wie vorher).
- **`test:coverage`** baut die Oberfläche nicht mehr, Globs unverändert.
- **Job `check`** führt `npm run test:unit` statt `npm test` aus. Der Job `e2e` behält seinen Schritt `build:ui`.
- **Doku**: `docs/ci.md` (Trigger, `concurrency`, Job `check`, offene Punkte) und der Abschnitt zu Testbefehlen und CI im `README.md`.

## Tests und Prüfung

- `npm run test:unit`: 1622 Tests bestanden (laut Entwickler).
- `npm run typecheck`: ohne Fehler.
- `npm run lint`: 1 Fehler in `src/runner/budget.test.ts:219` (`==` statt `===`), stammt aus dem vorherigen Merge und wurde nicht angefasst.
- `npm run format:check`: meldet 26 Dateien unter `src` und `frontend/src`, keine davon in diesem Auftrag geändert.
- Die YAML-Datei wurde nur durch Lesen geprüft (ein Parser-Lauf ist für Agents gesperrt). Ob die CI grün ist, zeigt erst der erste Lauf in GitHub. Die Dokumentation hat nichts davon erneut ausgeführt.

## Geänderte Dateien

- `.github/workflows/ci.yml`
- `package.json`
- `README.md`
- `docs/ci.md`

## Worauf zu achten ist

- **Offen: SHA-Pins.** `actions/checkout`, `actions/setup-node` und `actions/upload-artifact` stehen noch auf `@v4`. Die Agent-Umgebung hat keinen Netzzugriff, geraten wird nicht. Nachtragen: `git ls-remote --tags https://github.com/actions/<name>`, dann `uses: actions/<name>@<sha> # v4.x.y`. Der Auftrag ist damit erst nach diesem Schritt vollständig erledigt.
- **Runner-Standards unverändert.** `src/runner/runner-selection.ts` nutzt weiter `npm run build` und `npm test`, weil das für alle Projekte gilt und andere Projekte kein `test:unit` haben. Für AIdeation selbst in den Projekteinstellungen unter „Testbefehle“ `npm run build` und `npm run test:unit` eintragen, sonst baut ein Lauf die Oberfläche zweimal.
- **Rechte-Regeln unverändert.** `npm run test:unit` ist über die bestehende Regel `npm run:*` erlaubt (`permission-rules.ts`).
- **Nicht Teil des Auftrags:** Docker-Build und Typprüfung der Tests (eigener Auftrag „CI: E2E-Tests, Docker-Build und Typprüfung der Tests“). Jobs `docker`, `e2e` und der Schritt `typecheck` blieben unberührt.
- Der Lint-Fehler in `src/runner/budget.test.ts:219` ist ein bestehender Mangel und gehört in einen eigenen Auftrag.
- Keine Schema-Änderung, keine Migration.
