# .dockerignore: Backups, Testmedien und .env-Kopien ausschliessen

Auftrag 98bc3c28 (Bugfix, Sprint 23). Aus dem Code-Review vom 21.10.2026 (Stand `a4971e9`).

## Problem

Backups (über 200 MB Dumps), Testmedien unter `docs/tests/*/media` (667 PNG, 216 WebM) und `.env`-Kopien sollten nicht an den Docker-Daemon und nicht in eine Image-Schicht gelangen. Jeder `docker compose up --build`, auch der automatische Neustart (`src/runner/system-restart.ts`), wäre dadurch langsam und das Image gross; Screenshots mit App-Daten blieben dauerhaft in einer Schicht.

## Ist-Zustand vor dem Auftrag

Der Bug-Wächter stellte fest, dass der Zweig fast fertig war: `.dockerignore` schloss `backups`, `docs/tests`, `test-results`, `.dev-log`, `.env.*` und `playwright-report` schon aus, und das Dockerfile kopierte aus `docs/` nur noch drei Dateien (`laufzeit.md`, `workflows.md`, `agents-und-rechte.md`). Es fehlten nur Kleinigkeiten.

## Umsetzung

- **`.dockerignore`**:
  - `.dev-log-backups` neu: Merge-Abbruch-Patches des Runners können Projektcode samt Zugangsdaten enthalten.
  - `e2e` ersetzt `e2e/test-results`: Kein Dockerfile kopiert die Playwright-Tests (API: `src`, Oberfläche: `frontend`).
- **`src/core/docker-build.test.ts`**:
  - Die Hilfsprüfung `segmentMatches` versteht `*` jetzt auch innerhalb eines Pfadteils. Vorher galt `*` nur als ganzer Teil, ein Muster wie `.env.*` wurde nie getroffen.
  - Neue Prüfpfade: `.dev-log-backups/merge-abbruch.patch`, `.env.bak-2026-10-21`, `e2e/test-results/video.webm`.
  - Der bestehende Test, dass die drei Dateien aus `docs/` im Image bleiben, ist unverändert.
- Unverändert: `Dockerfile`, `src/runner/system-restart.ts`, `deploy/frontend`. Der Build-Kontext bleibt `.`.

## Tests

`npm test` lief vollständig durch (1601 Tests, alle bestanden, darunter die beiden Docker-Tests).

Nicht belegt:
- Die Testdatei wurde nicht einzeln und nicht gegen die alte `.dockerignore` ausgeführt (der Wächter erlaubt nur die ganze Suite). Nach Code-Lage wäre sie rot gewesen, weil `.dev-log-backups` fehlte.
- Es lief kein `docker compose build`. Wie klein Build-Kontext und Image jetzt sind, ist nicht gemessen.

## Geänderte Dateien

- `.dockerignore`
- `src/core/docker-build.test.ts`

## Worauf zu achten ist

- Ein Mensch sollte einmal `docker compose build` ausführen und prüfen, dass Build-Kontext und API-Image weder `docs/tests` noch `backups` noch `e2e` enthalten.
- Das Muster `e2e` ist breit. Kopiert ein Dockerfile künftig etwas aus `e2e/`, muss die Regel angepasst werden.
- Wer weitere Dateien aus `docs/` zur Laufzeit liest (z. B. `src/api/workflow-docs.ts`), muss sie im Dockerfile ergänzen; sonst fehlen sie im Image.
- Das Frontend-Image (`deploy/frontend`) kopiert nur `frontend/`, `src/core/…` und `deploy/frontend/…` und ist von der Änderung nicht berührt.
