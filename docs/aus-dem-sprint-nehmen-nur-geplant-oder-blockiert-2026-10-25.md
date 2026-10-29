# Aus dem Sprint nehmen: nur für geplante oder blockierte Aufträge

Auftrag e432cff4 (Bugfix, 25.10.2026). Sprint 23. Gefunden im Code-Review vom 21.10.2026 (Stand `a4971e9`).

## Ursache

- `POST /development/:id/remove-from-sprint` schloss nur `in_progress` und `done` aus. Aufträge in `approval` oder `rejected` verloren Sprint und Agent, behielten aber `review_branch`. „Freigeben“ mergte sie danach ohne Sprintbezug.
- Der Sprint-Status wurde nicht geprüft. Aus einem Sprint im Review verließ ein Auftrag den Sprint, obwohl sein Branch schon im PR steckte.
- Die Oberfläche (`editable`) schloss nur `completed` und `cancelled` aus. Umsortieren und Herausnehmen erschienen auch bei Sprints im Review.

## Umsetzung

- **`SPRINT_REMOVABLE_DEVELOPMENT_STATUSES`** (`src/core/development-transitions.ts`): `backlog`, `planned`, `blocked`. Eine Positivliste ersetzt die Negativliste. `SPRINT_LOCKED_DEVELOPMENT_STATUSES` gilt nur noch für die Sprint-Auswahl per PATCH.
- **`remove-from-sprint`** (`src/api/development.ts`): Auftrags- und Sprint-Status stehen in derselben UPDATE-Anweisung (`status IN (...)` und `EXISTS` auf einen Sprint mit `planned`/`active`). Ein Auftrag kann zwischen Lesen und Schreiben also nicht mehr auf `in_progress` wechseln. Trifft nichts zu: 409, es wird nichts geschrieben.
- **Oberfläche:** `canEditSprintOrders(sprintStatus, canPlan)` (`sprint-phases.ts`) gilt nur für `isAssignableSprintStatus` und das Recht `plan`. `editable` in `sprint-orders.component.ts` nutzt es. `canTakeIn` entfiel, weil es dann doppelt war. Bei Sprints im Review oder danach fehlen Umsortieren (↑/↓), Herausnehmen und „Aufträge hinzufügen“.

## Geänderte Dateien

- `src/api/development.ts`
- `src/core/development-transitions.ts`
- `src/api/development-status.test.ts`
- `frontend/src/app/features/sprints/sprint-orders.component.ts`
- `frontend/src/app/features/sprints/sprint-orders.component.html`
- `frontend/src/app/features/sprints/sprint-phases.ts`
- `frontend/src/app/features/sprints/sprint-phases.spec.ts`
- `docs/workflows.md` (Absatz „Aus dem Sprint nehmen“)

## Tests

- `src/api/development-status.test.ts`: Auftrag in `approval` und Auftrag in einem Sprint im `review` ergeben 409 und nichts wird geschrieben. Gegenprobe: `planned` und `blocked` gehen weiter durch.
- `sprint-phases.spec.ts`: Spec für `canEditSprintOrders`.
- Stand der Übergabe: Typecheck war grün. Die Tests ließen sich im Entwickler-Schritt nicht starten (Freigabe nötig). Bitte ohne Abdeckungs-Flags ausführen: `npx --no-install tsx --test src/api/development-status.test.ts` und `npx --no-install tsx --test frontend/src/app/features/sprints/sprint-phases.spec.ts`.

## Worauf zu achten ist

- **Offen, außerhalb dieses Auftrags:** `POST /sprints/:id/order` (`src/api/sprints.ts:329`) prüft den Sprint-Status serverseitig nicht. Nur die Oberfläche blendet das Umsortieren bei Sprints im Review aus. Dafür sollte ein eigener Auftrag entstehen.
- Die Fehlermeldung des 409 nennt jetzt beide Bedingungen (Auftrags- und Sprint-Status).
- Ein abgelehnter oder freigabereifer Auftrag lässt sich nicht mehr aus dem Sprint nehmen. Er muss erst über „Erneut versuchen“ oder „Wieder einplanen“ in einen planbaren Zustand.
