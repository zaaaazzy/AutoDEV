# Bugs automatisch nach Bereich kategorisieren

Auftrag 26680790-2de3-45a2-8bc1-f71fd969d4e2 (Feature).

## Ziel

Bugs wurden von den meisten Erzeugern ohne Kategorie angelegt. Jetzt bekommt jeder neue Bug eine Kategorie aus den betroffenen Dateipfaden, sonst aus einer Einschätzung des lokalen Modells. Bestehende Bugs ohne Kategorie füllt ein einmaliger Wartungsjob. Bugliste und Statistik filtern bzw. zählen nach Kategorie, und die Korrektur von Hand bleibt erhalten. Technische Details: `docs/bug-kategorien.md`, `docs/wartungs-jobs.md`.

## Umsetzung

- **Zuordnung aus Pfaden:** `categoryFromBug` in `src/core/bug-category.ts` (rein, deterministisch). `frontend/` → `frontend`, `src/` → `backend`, beides → `fullstack`. Nur `src/agent/agent-guard`, `path-policy`, `permission` (als ganzes Pfadsegment) → `security`. Nur `deploy/` u. Ä. → `infrastructure`, nur Doku → `docs`. Unklare Fälle bleiben offen.
- **Lokales Modell:** `src/agent/bug-classifier.ts`, `afterBugCreated`. Reine Textanfrage an Ollama ohne Werkzeuge, Zeitlimit 20 s, im Hintergrund nach dem Anlegen. Übernommen wird nur einer der sechs Werte und nur per `UPDATE … WHERE category IS NULL`. Fehler, Zeitlimit oder ungültige Antwort lassen die Kategorie leer; das Anlegen scheitert nie.
- **Erzeuger:** `fileBugs` (`BugDraft.paths`, `src/core/test-bugs.ts`; `scripts/test-full.ts` wartet auf offene Einstufungen), `reportAgentBug` und `POST /projects/:slug/bugs` (`src/api/bugs.ts`; mitgeschickte `category` bleibt unverändert), `src/agent/troubleshoot.ts`, `src/runner/github-sync.ts`, `src/runner/git-sync/sprint-reviews.ts`. Unit-Tests aus TAP tragen die Testdatei (`src/core/test-results.ts`), damit ein roter Test unter `src/core/` `backend` ergibt.
- **Wartungsjob `bug_categories`:** `src/runner/bug-category-job.ts`, Migration 26 legt den Eintrag in `scheduled_jobs` an (Intervall 1 Tag), Registrierung in `src/runner/scheduler.ts`. Stapel zu 50 nur über `category IS NULL`, Stand in `scheduled_jobs.state`, am Ende `done = true`; weitere Läufe ändern nichts. Gesetzte Kategorien bleiben unberührt, Aufträge werden nicht angefasst.
- **Oberfläche:** Kategoriefilter in der Bugliste über `categoryColumn(…, true)` der gemeinsamen `DataTableComponent` (`frontend/src/app/shared/data-table/columns.ts`, `bugs.component.ts`); Statistikkarte „Nach Kategorie“ mit offenen und begrabenen Bugs und einer Zeile „Ohne Kategorie“, nur nach dem Feld `category` (`bug-stats.ts`). Das Auswahlfeld zur Korrektur und `PATCH /bugs/:id` sind unverändert.

## Geänderte Dateien

- Neu: `src/core/bug-category.ts`, `.test.ts`; `src/agent/bug-classifier.ts`, `.test.ts`; `src/runner/bug-category-job.ts`, `.test.ts`
- Geändert: `src/core/test-bugs.ts`, `src/core/test-results.ts`, `src/api/bugs.ts`, `src/agent/troubleshoot.ts`, `src/runner/github-sync.ts`, `src/runner/git-sync/sprint-reviews.ts`, `src/runner/scheduler.ts`, `src/db/migrations.ts`, `scripts/test-full.ts`
- Frontend: `frontend/src/app/features/bugs/bugs.component.ts`, `bug-stats.ts`, `frontend/src/app/shared/data-table/columns.ts`
- Tests ergänzt: `src/api/bugs.test.ts`, `src/api/scheduled-jobs.test.ts`, `src/core/test-bugs.test.ts`, `src/core/test-results.test.ts`, `src/db/migrations.test.ts`, `src/runner/scheduler.test.ts`, `bug-stats.spec.ts`, `columns.spec.ts`, `e2e/full-ui.check.ts`
- Doku: `docs/bug-kategorien.md`, `docs/wartungs-jobs.md`, `docs/laufzeit.md`, `docs/erm.md`, diese Datei

## Worauf zu achten ist

- Der CHECK-Constraint und der Wertesatz `CATEGORIES` bleiben unverändert; es gibt keinen Ausweichwert.
- Der Pfad `agent-guard` zählt nur als ganzes Segment (`my-agent-guard.ts` ist `backend`).
- Der Wartungsjob läuft erst nach der Migration 26. Worker nach dem Deployment neu starten.
- Abschalten der Modell-Einstufung: `DEV_LOG_BUG_CATEGORY_MODEL=off`; unter dem Node-Test-Runner ist sie standardmäßig aus.
- Die Statistik „Nach Kategorie“ nutzt bewusst keinen Pfad-Fallback; die Karte „Wo“ behält ihn.
- „Bug-Wächter“ wurde als `reportAgentBug` (`src/runner/autofix.ts`) gedeutet. Das sollte bei der Abnahme bestätigt werden.
- Feinere Bereiche (z. B. Git-Sync) sind nicht enthalten; sie bräuchten eine eigene Spalte.

## Teststand

Die Tests sind geschrieben. Ein grüner Lauf von `npm run typecheck`, `npm test`, Frontend-Specs und `full-ui.check.ts` wurde vom Dokumentierer nicht ausgeführt und ist hier nicht belegt; das bleibt Sache des Testers.

## Sprint und Anfrage/TODO

| Auftrag | Zustand | Details |
|---|---|---|
| 26680790 Bugs automatisch nach Bereich kategorisieren | umgesetzt, wartet auf Tester | Pfadmodul, Modell-Einstufung, sechs Erzeuger, Job `bug_categories` (Migration 26), Filter und Statistik |

- Anfrage/TODO: Tester soll Typprüfung, Unit-Tests, Frontend-Specs und den Oberflächentest ausführen (`npm test` bzw. `npm run`, nicht `npx tsx`). Abnahme bestätigen, ob `reportAgentBug` der gemeinte Bug-Wächter ist. Nach dem Deployment Worker neu starten, damit Migration 26 und der Job greifen.
