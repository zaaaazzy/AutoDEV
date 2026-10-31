# Bugs automatisch nach Bereich kategorisieren

Jeder neue Bug bekommt beim Anlegen eine Kategorie aus dem bestehenden Wertesatz `frontend, backend, fullstack, infrastructure, docs, security` (`CATEGORIES` in `src/core/validation.ts`). Einen Ausweichwert gibt es nicht; ohne eindeutige Zuordnung bleibt die Kategorie leer.

## Ablauf

1. **Mitgeschickt:** `POST /projects/:slug/bugs` mit `category` speichert genau diesen Wert.
2. **Aus Pfaden:** `categoryFromBug` (`src/core/bug-category.ts`, rein und deterministisch) liest ausdrückliche Pfade (`BugDraft.paths`, z. B. die Testdatei) und die in Titel und Beschreibung genannten Dateipfade:
   - `frontend/…` → `frontend`, `src/…` → `backend`, beides → `fullstack`
   - nur `src/agent/agent-guard…`, `src/agent/path-policy…`, `src/agent/permission…` → `security` (nur als ganzes Pfadsegment, `my-agent-guard.ts` zählt als Backend)
   - nur `deploy/`, `.github/`, `Dockerfile`, `docker-compose.yml`, `start.sh` → `infrastructure`; Code zusammen mit Betrieb ist nicht eindeutig
   - nur `docs/` bzw. `README.md` → `docs`; neben Code zählt Doku nicht
   - `node_modules`, `..` und URLs zählen nicht
3. **Lokales Modell:** Ordnet kein Pfad eindeutig zu, fragt `afterBugCreated` (`src/agent/bug-classifier.ts`) nach dem Anlegen im Hintergrund das lokale Modell (Ollama `/api/chat`, reine Textanfrage ohne Werkzeuge, Modell der Rolle `author`, Zeitlimit 20 s, nacheinander, höchstens 50 wartend). Nur einer der sechs Werte wird übernommen, und nur solange der Bug noch keine Kategorie hat (`UPDATE … WHERE category IS NULL`). Fehler, Zeitlimit oder ungültige Antwort lassen die Kategorie leer; das Anlegen des Bugs scheitert nie und wartet nicht auf das Modell.
   - Abschalten: `DEV_LOG_BUG_CATEGORY_MODEL=off`. Unter dem Node-Test-Runner ist die Anfrage standardmäßig aus.
   - `scripts/test-full.ts` wartet vor dem Schließen der Datenbank höchstens 60 s auf offene Einstufungen.

## Erzeuger

| Erzeuger | Stelle |
| --- | --- |
| Tester, Oberflächentest, kompletter Test | `fileBugs` in `src/core/test-bugs.ts` (Testdatei als `paths`) |
| Auto-Fix / Bug-Wächter | `reportAgentBug` in `src/api/bugs.ts` (optional `paths`) |
| Problemanalyse | `src/agent/troubleshoot.ts` |
| GitHub-Import, CI-Fehler | `src/runner/github-sync.ts`, `src/runner/git-sync/sprint-reviews.ts` |
| Von Hand | `POST /projects/:slug/bugs` ohne `category` |

Produktionsfehler und Routinen setzen ihre Kategorie wie bisher selbst.

Unit-Tests aus TAP (`parseTapCases`) tragen jetzt die Testdatei aus `location` (relativ zum Arbeitsordner). Damit bekommt ein fehlgeschlagener Unit-Test unter `src/core/` die Kategorie `backend`. Playwright liefert die Datei relativ zum Testordner (z. B. `full-ui.check.ts`); ohne Ordner im Pfad entscheidet das Modell.

## Wartungsjob `bug_categories`

- Angelegt per Migration 25 (`scheduled_jobs`, aktiv, Intervall 1 Tag); Code in `src/runner/bug-category-job.ts`.
- Liest nur Bugs mit `category IS NULL`, in Stapeln zu 50 nach `id`, und schreibt nur mit `WHERE category IS NULL`. Gesetzte oder von Hand korrigierte Kategorien bleiben, auch wenn die Pfade etwas anderes ergäben.
- Der Stand (`cursor`, `updated`, `skipped`) steht nach jedem Stapel in `scheduled_jobs.state`; ein Abbruch am Zeitlimit setzt beim nächsten Lauf fort. Am Ende steht `state.done = true`, danach ändert kein Lauf mehr etwas (auch nicht an später angelegten Bugs ohne Kategorie).
- Bugs, die weder Pfade noch Modell einordnen, bleiben ohne Kategorie und werden nicht erneut versucht.
- Aufträge werden nicht angefasst: Die Vererbung der Kategorie (`development_items_inherit_category`) greift nur beim Anlegen eines Auftrags.

## Oberfläche

- Bugliste: Die Spalte „Kategorie“ hat einen Auswahlfilter mit allen sechs Kategorien und „Ohne Kategorie“ (`categoryColumn(…, true)` in `frontend/src/app/shared/data-table/columns.ts`). Chips, „Zurücksetzen“ und der Leertext laufen über die gemeinsame `DataTableComponent`.
- Statistik: Karte „Nach Kategorie“ mit offenen und begrabenen Bugs je Kategorie und einer Zeile „Ohne Kategorie“. Sie zählt nur das Feld `category`, nicht die Pfade aus der Beschreibung (die Karte „Wo“ behält ihren Pfad-Fallback).
- Korrektur von Hand wie bisher über das Auswahlfeld im Bearbeiten-Formular (nur mit Recht „Planen“) bzw. `PATCH /bugs/:id` mit `category`.

## Tests

- `src/core/bug-category.test.ts`, `src/agent/bug-classifier.test.ts`, `src/runner/bug-category-job.test.ts`
- ergänzt: `src/api/bugs.test.ts` (mitgeschickte Kategorie bleibt, Pfade, leer ohne Modell, `reportAgentBug`, PATCH nur `category`), `src/core/test-bugs.test.ts`, `src/core/test-results.test.ts`, `src/db/migrations.test.ts`, `src/runner/scheduler.test.ts`, `src/api/scheduled-jobs.test.ts`, `frontend/src/app/features/bugs/bug-stats.spec.ts`, `frontend/src/app/shared/data-table/columns.spec.ts`, `e2e/full-ui.check.ts` (Bugs: Kategorie beim Anlegen, Filter „Backend“, Statistik, Zurücksetzen)
