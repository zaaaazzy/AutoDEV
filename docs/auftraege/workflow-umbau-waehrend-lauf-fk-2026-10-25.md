# Workflow während eines Laufs ändern bricht den Lauf ab (FK agent_run_steps_workflow_step_id_fkey)

Auftrag c6952ea1 (Bugfix, gefunden am 25.10.2026 bei TowerField 28a24457). Sprint 23.

## Ursache

Der Runner lädt den Workflow einmal je Zyklus (`loadWorkflow`). Wird im Agents-Menü ein Schritt oder Agent gelöscht, während ein Auftrag läuft, schreibt `runStep` (`src/runner/runner-steps.ts`) beim nächsten Schritt eine `workflow_step_id` bzw. `agent_id`, die es nicht mehr gibt. Der Fremdschlüssel schlägt zu, der Lauf endet mit „Run … aborted“. Der Auftrag stand danach auf „blockiert“ mit leerem `failure`, obwohl Tester und Reviewer schon grün waren. Der Fehler stand nur im Worker-Log.

## Umsetzung

- **Schritt läuft ohne Verweis zu Ende** (`src/runner/runner-steps.ts`, `runStep`): Der INSERT in `agent_run_steps` löst `agent_id` und `workflow_step_id` über Unterabfragen (`SELECT id FROM agents|workflow_steps WHERE id = …`) auf. Gibt es die Zeile nicht mehr, wird `NULL` gespeichert. Name (`agent_name`) und Phase bleiben erhalten. Der Lauf wird mit den geladenen Schritten beendet.
- **Nie „blockiert“ ohne Text** (`src/runner/runner.ts`, `runWorkItem`): Bei jedem unerwarteten Fehler (nicht Ordnerproblem, nicht Abbruch) setzt der Runner `ctx.stopReason = "Lauf abgebrochen: <Meldung>"` und schreibt ihn nach `development_items.failure`.
- **Fortsetzen**: `runner.ts:114` und `runner-agent.ts:193` suchen mit `workflow_step_id ?? agent_id` bzw. `COALESCE`. Mit `NULL` greifen sie auf den Agent zurück; dort war keine Änderung nötig.
- Kein Schema-Eingriff (kein `ON DELETE SET NULL`): Das hätte den INSERT mit bereits gelöschter ID nicht verhindert.

## Tests (`src/runner/runner.test.ts`)

- **Workflow mitten im Lauf umgebaut:** Der Test-Pool verhält sich wie der Fremdschlüssel in Postgres. Während der Entwickler läuft, wird der Schritt des Prüfers gelöscht. Erwartet: Lauf bestanden, Auftrag `done`, beim Prüfer `workflow_step_id = null`, `failure` leer.
- **Unerwarteter Fehler im Lauf:** Erwartet: Status `blocked`, `failure = 'Lauf abgebrochen: …'`.

## Geänderte Dateien

- `src/runner/runner-steps.ts`
- `src/runner/runner.ts`
- `src/runner/runner.test.ts`
- `docs/workflows.md` (Abschnitt 4a: „Umbau während eines Laufs“)
- `docs/workflow-umbau-waehrend-lauf-fk-2026-10-25.md` (diese Datei)

## Worauf zu achten ist

- **Auswertungen:** Schritte mit `workflow_step_id`/`agent_id` = `NULL` sind möglich. Abfragen, die per JOIN auf `agents` oder `workflow_steps` zählen, müssen `LEFT JOIN` nutzen und `agent_name`/`phase` verwenden.
- **Alter Workflow bis zum Ende:** Der laufende Auftrag nutzt bis zum Ende den alten Workflow; erst der nächste Lauf den neuen.
- **Tests:** Über `npm test` ausführen (1548 grün laut Entwickler). `node --import tsx --test`, `npx tsx --test` und Coverage-Flags sperrt der Wächter.

## Sprint 23 und Anfrage/TODO

- Zustand des Auftrags: umgesetzt, Tests geschrieben, wartet auf Tester/Review.
- Offen: keine. Optional später: weiche Löschung von Workflow-Schritten, falls der Verlauf den Schrittnamen auch nach Umbau mit dem Schritt verknüpfen soll.
