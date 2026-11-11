# Sprintbudget zählt nur Läufe der Sprint-Aufträge bis Sprintende

Auftrag 1ddaeb4b (Bugfix, Sprint 23). Aus dem Code-Review vom 21.10.2026 (Stand `a4971e9`).

## Problem

Zum Sprintbudget zählte der ganze Projektverbrauch ab Sprintbeginn (Chat, Visionär, Aufträge ausserhalb des Sprints), ohne Obergrenze beim Sprintende. Bugfix-Aufträge erbten zudem die `sprint_id` eines abgeschlossenen Sprints. Für sie wuchs der Sprintverbrauch immer weiter, sie blieben wegen „Sprintlimit“ blockiert, und `releaseBudgetBlocks` gab sie nie frei.

## Umsetzung

- **Nur Läufe der Sprint-Aufträge** (`src/runner/budget.ts`): Neu `sprintSpendByRole` und `sprintSpend` summieren `agent_run_steps` über `agent_runs` und `development_items.sprint_id` des Sprints, ab Sprintbeginn. `periodSpend` nutzt sie für die Periode „sprint“ (mit und ohne Rollenlimit).
- **Kein Sprintlimit für nicht aktive Sprints** (`sprintStart`): Es liefert nur noch einen Sprint mit Status `active`. Ist der Sprint des Auftrags geplant, im Review, abgeschlossen oder abgebrochen, gilt kein Sprintlimit. Damit wird auch eine Sprintlimit-Blockade in `releaseBudgetBlocks` beim nächsten Durchgang frei. Ein Sprintende braucht es als Obergrenze nicht, weil das Limit nur für den aktiven Sprint gilt.
- **Bugfix-Aufträge erben keinen geschlossenen Sprint** (`src/runner/autofix.ts`, `queueBugFix`): Der Sprint des blockierten Auftrags wird nur übernommen, solange er nicht abgeschlossen oder abgebrochen ist. Sonst kommt der Auftrag in den aktiven Sprint, ohne aktiven Sprint ohne Sprint auf `main` (wie `detachFromClosedSprints`).
- **Rollenbudget-Anzeige** (`src/api/budget.ts`, `collectRoleBudget`): Der Sprintverbrauch je Rolle kommt aus `sprintSpendByRole`.
- **Doku**: Budget-Abschnitt in `docs/workflows.md`.

## Tests

- `src/runner/budget.test.ts`
  - „Sprintlimit zählt nur Läufe der Sprint-Aufträge“: Chat- und Projektverbrauch von 50 000 Tokens zählen nicht mit, der Sprint steht bei 20 %.
  - „Abgeschlossener Sprint: kein Sprintlimit, wegen Sprintlimit blockierter Auftrag wird frei“.
- `src/runner/autofix.test.ts`: Ein Bugfix-Auftrag erbt keinen abgeschlossenen Sprint.

`npm test` lief laut Entwickler durch (1622/1622). Einzeldateien ließ der Wächter nicht zu; die Tests wurden von der Dokumentation nicht erneut ausgeführt.

## Geänderte Dateien

- `src/runner/budget.ts`, `src/runner/budget.test.ts`
- `src/runner/autofix.ts`, `src/runner/autofix.test.ts`
- `src/api/budget.ts`
- `docs/workflows.md`

## Worauf zu achten ist

- **Chat, Auftragsautor und Visionär zählen nicht mehr zum Sprintlimit.** `agent_usage` hat keine Auftragszuordnung. Zum Tageslimit zählen sie weiter.
- **Nur der aktive Sprint hat ein Limit.** Aufträge in einem geplanten Sprint oder im Review werden nicht gegen das Sprintlimit geprüft.
- Tageslimit, Rollenlimits und `spendByRole` sind unverändert. Die Budget-Warnungen (`budget_warnings`) behalten ihren Periodenschlüssel (Sprint-ID).
- Keine Schema-Änderung, keine Migration.
