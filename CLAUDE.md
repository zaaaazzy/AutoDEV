# AIdeation – Hinweise für Agents und Entwickler

Gilt für jeden, der hier Code schreibt: Menschen, Claude-Sitzungen und die eigenen AIdeation-Agents. Überblick,
Betrieb und Konfiguration stehen im [README](README.md).

## Aufbau

- `src/api/` Express-Routen. Eine Datei je Bereich, registriert in `src/api/app.ts`. Rechte immer über
  `access({ role, tenant })` aus `src/api/access.ts`.
- `src/core/` Hilfen ohne HTTP und ohne Runner-Bezug (Validierung, Befehle, Sperren, Status).
- `src/db/` Schema, Migrationen, Transaktionen und Datenzugriff (`*-repository.ts`).
- `src/agent/` Agents, Chat, Werkzeug- und Pfadregeln. `src/runner/` Worker, Sprint-Ablauf, Git, Tests.
- `frontend/src/app/` Angular (Standalone, Signals): `core/` Store, API, Modelle; `shared/` kleine Bausteine;
  `features/<bereich>/` je ein Bereich der Oberfläche.

## Regeln

- **Status-Werte** nie als Literal schreiben (`'in_progress'`), sondern aus `src/core/status.ts`
  (`DEVELOPMENT_STATUS.inProgress`). In SQL: `'${DEVELOPMENT_STATUS.backlog}'`. Im Frontend aus
  `frontend/src/app/core/models.ts`. Der Test `src/core/status-literals.test.ts` meldet Literale im Backend.
- **Gemeinsame Typen** (Status, Budget, Modell-Routing) stehen einmal im Backend: `src/core/status.ts` und
  `src/core/shared-types.ts`. Das Frontend importiert sie in `frontend/src/app/core/models.ts`, statt sie nachzubauen.
  Diese Dateien bleiben ohne Imports, sonst kompiliert die Oberfläche nicht. Neue Dateien, die das Frontend aus
  `src/core` nutzt, in `frontend/tsconfig.app.json` und `frontend/tsconfig.spec.json` unter `include` eintragen.
- **Datenzugriff**: Neue Abfragen gehören in ein Repository-Modul in `src/db/` (Vorbild:
  `src/db/development-repository.ts`, `src/db/project-repository.ts`), nicht direkt in Route-Handler. Spaltenlisten
  und `AS "camelCase"` nur dort.
- **Eingaben prüfen** mit den Helfern aus `src/core/validation.ts`, eine Prüffunktion je Body (Vorbild:
  `parseNewOrder` in `src/api/development-input.ts`), nicht als lange `if`-Kette im Handler.
- **Funktionen kurz halten**: Route-Handler als benannte Funktionen; eine `register*Routes`-Funktion verbindet nur
  Pfad, Rechte und Handler (Vorbild: `src/api/projects.ts` mit `src/api/project-input.ts`). Neue Funktionen über
  ~80 Zeilen aufteilen; den Worker-Takt zeigt `src/runner/worker-loop.ts`, den Schritt-Ablauf `src/runner/runner-steps.ts`.
- **Mehrstufige Änderungen** in `withTransaction` (`src/db/transaction.ts`).
- **Keine Non-null-Assertions** (`x!`) im Produktionscode: Lint bricht ab. Stattdessen prüfen und früh zurückkehren.
- **CSS**: Farben nur über Variablen aus `frontend/src/styles/01-base.css` (`var(--…)`), keine neuen Hex-Werte in
  den Bereichsdateien. Fehlt eine Farbe, als Token in `01-base.css` ergänzen.
- Kommentare auf Deutsch und nur, wenn sie das Warum erklären.

## Prüfen vor dem Commit

```bash
npm run lint && npm run format:check && npm run typecheck && npm run test:unit
```

Datenbank-Tests brauchen `DEV_LOG_TEST_ADMIN_DATABASE_URL`, sonst werden sie übersprungen. Oberflächentests:
`npm run test:e2e` (vorher `npm run build:ui`).

## Commits und Doku

- Conventional Commits auf Deutsch: `fix(bereich): …`, `feat(bereich): …`, `refactor(bereich): …`.
- Berichte zu einzelnen Aufträgen (auch Benutzerhandbuch-Abschnitte je Auftrag) gehören nach
  `docs/auftraege/<thema>-<JJJJ-MM-TT>.md`, nicht direkt nach `docs/`. Direkt in `docs/` liegen nur die
  dauerhaften Dokumente (Installation, Workflows, Agents und Rechte, ERM, Laufzeit, CI, Wartungs-Jobs).
  Testberichte und Bug-Wächter-Berichte legt der Worker selbst in `docs/tests/` und `docs/risiken/` ab.
