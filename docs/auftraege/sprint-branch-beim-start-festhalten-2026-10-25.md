# Sprint-Branch beim Start festhalten statt aus dem Namen ableiten

Auftrag 97fdce0c (Bugfix, Code-Review vom 21.10.2026, Stand `a4971e9`). Sprint 23.

## Ursache

Der Branchname wurde bei jedem Zugriff aus dem aktuellen Sprintnamen gebildet (`sprint/<slug>`). Der Name ist per `PATCH /api/sprints/:id` änderbar und nicht eindeutig (in der Datenbank gab es zwei Sprints „Sprint 5“ mit demselben Branch). Nach einer Umbenennung legte `checkoutSprintBranch` einen neuen Branch von `main` an. Beim Abschluss kam nur der Teil nach der Umbenennung nach `main`, der Tag zeigte auf einen unvollständigen Stand. Fehlte der Branch, sicherte `pushSprint` den aktuellen Branch und meldete trotzdem `done`.

## Umsetzung

- **Neue Spalte `sprints.branch`** (Migration 13 `sprint-branch-beim-start-festhalten`, `src/db/migrations.ts`). Sie ist von `git_branch` (Branch der letzten Sicherung, wird in der Oberfläche angezeigt) getrennt; `git_branch` bleibt unverändert.
- **Vergabe beim Start:** Ein Trigger (`sprints_fix_branch`) setzt den Branch einmal, sobald der Sprint den Status „geplant“ verlässt. Name: `sprint/<slug zum Startzeitpunkt>`. Existiert der Branch im Projekt schon bei einem anderen Sprint, werden die ersten sechs Zeichen der Sprint-ID angehängt. Ein eindeutiger Index (`project_slug, branch`) sichert das ab.
- **Altdaten:** Die Migration belegt alle nicht geplanten Sprints. Laufende Sprints behalten ihren heutigen Branch, bei doppelten Namen bekommen die übrigen die ID angehängt. Die Migration ist idempotent, hat keine CHECK-Regel und löscht oder legt keine Zeilen neu an.
- **Lesen überall aus der Spalte:** `sprintBranchOf` in `src/runner/git-sync/git-helpers.ts`, genutzt in `git-sync.ts`, `git-sync/order-branch.ts`, `git-sync/reconcile.ts`, `git-sync/sprint-sync.ts`, `review-slots.ts`, `runner.ts` und `sprint-commits.ts`.
- **Umbenennen bleibt erlaubt** und ändert den Branch nicht. `branch` ist per API nicht schreibbar (`src/api/sprints.ts`).
- **Fehlender Branch:** `pushSprint` meldet die Git-Sicherung als gescheitert, wenn der Sprint erledigte Aufträge hat, aber kein Branch vorhanden ist. Es wird nichts committet, getaggt oder gemergt.

## Tests

- `src/runner/git-sync.test.ts`: Sprint nach dem ersten gemergten Auftrag umbenennen, der Abschluss enthält alle Aufträge. Fehlender Branch ergibt einen Fehler statt `done`.
- `src/db/sprint-branch.test.ts`: Migration (doppelte Namen, aktive Sprints, Idempotenz) und Trigger. Braucht die lokale PostgreSQL, sonst werden die Tests übersprungen.
- Ausführen mit `npm test`. Im ersten Lauf waren 2 Tests in `runner.test.ts` rot (Fake-Pool liefert eine Sprint-Zeile ohne Namen); `sprintOf` behandelt so eine Zeile jetzt wie „kein Sprint“.

## Geänderte Dateien

- `docs/workflows.md` (Absatz „Sprint-Branch beim Start festgehalten“)
- `src/api/sprints.ts`
- `src/db/migrations.ts`
- `src/db/sprint-branch.test.ts`
- `src/runner/git-sync.test.ts`
- `src/runner/git-sync.ts`
- `src/runner/git-sync/git-helpers.ts`, `order-branch.ts`, `reconcile.ts`, `sprint-sync.ts`
- `src/runner/review-slots.ts`
- `src/runner/runner.ts`
- `src/runner/sprint-commits.ts`
- `docs/sprint-branch-beim-start-festhalten-2026-10-25.md` (diese Datei)

## Worauf zu achten ist

- `sprints.branch` und `sprints.git_branch` nicht verwechseln.
- Geplante Sprints haben noch keinen Branch; er entsteht erst beim Start.
- Bestehende Branches aktiver Sprints behalten ihren Namen; die Migration übernimmt den heutigen Stand.
- Spätere Migrationen dürfen Trigger und Index nicht entfernen, sonst entstehen wieder Namenskollisionen.

## Sprint und Anfrage/TODO

- Zustand des Auftrags: umgesetzt, Tests geschrieben, wartet auf Tester/Review.
- Offen: keine.
