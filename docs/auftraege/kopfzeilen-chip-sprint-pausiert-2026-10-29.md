# Kopfzeilen-Chip meldet „Sprint pausiert“ statt „Sprint läuft ▶“

Auftrag 921801de (Bugfix) aus der Gesamtprüfung vom 21.10.2026 (Bereich Frontend, Schwere niedrig). Stand: 29.10.2026. Der Auftrag betrifft nur das Frontend.

## Problem
`sprintHealth` und `sprintState` in `app.component.ts` werteten `sprint.pausedAt` nicht aus. Ein pausierter Sprint bekam Ton „ok“, Text „Sprint läuft“ und ▶, in der Kopfzeile, auf dem Handy-Chip und im `aria-label`. Der Worker startet in der Pause nichts mehr.

## Was umgesetzt wurde
- **`core/nav-counts.ts`:** Die Logik steht jetzt in reinen Funktionen.
  - `sprintHealthOf({ workerDown, paused, failed })` liefert Ton und Text. Vorrang: Worker offline > pausiert > Fehler > läuft.
    - Worker offline: `stopped`, „Sprint gestoppt: Worker offline“
    - pausiert: `paused`, „Sprint pausiert“
    - Fehler: `warn`, „Sprint läuft mit Fehlern“
    - sonst: `ok`, „Sprint läuft“
  - `sprintStateOf({ finished, tone, busy })` liefert den Chip-Zustand. Vorrang: fertig > Worker offline > pausiert > Fehler > läuft oder wartet.
  - Neue Typen `SprintTone` (um `paused` erweitert) und `SprintState` (um `paused` erweitert).
- **`app.component.ts`:** `sprintHealth` und `sprintState` rufen diese Funktionen auf. `paused` kommt aus `!!sprint.pausedAt`.
- **`app.component.html`:** An beiden Stellen (Pill in der Kopfzeile, Handy-Chip) gibt es `@case ('paused') { ⏸ }`. Der Text kommt aus `sprintHealth().text`, damit auch das `aria-label` „Sprint pausiert“ sagt.
- **`styles/02-layout.css`:** `.sprint-chip.state-paused .sprint-state` und `.sprint-pill.state-paused .sprint-state` mit gedämpfter Farbe (`--muted`), ohne Blinken.

## Tests
`core/nav-counts.spec.ts` prüft über eine Hilfsfunktion `chip(...)` Ton, Text und Zustand:
- pausiert, auch während ein Agent arbeitet: „Sprint pausiert“, Zustand `paused`, kein „läuft“, kein ▶ im Text
- pausiert mit Fehlern: bleibt `paused`
- pausiert und Worker offline: Worker offline gewinnt
- pausiert und fertig: `done`
- fortgesetzt: „Sprint läuft“ (`running` oder `idle`), mit Fehlern „Sprint läuft mit Fehlern“

Für diese Dokumentation wurden die Tests nicht erneut ausgeführt. Die Angaben stammen vom Entwickler und aus dem Diff.

## Geprüft
- Die API setzt `paused_at` beim Fortsetzen auf NULL (`src/api/sprints.ts`, Fortsetzen). Danach lädt `store.perform` die Daten neu, der Chip springt zurück auf „Sprint läuft“.
- `pausedAt` ist im Frontend-Typ vorhanden (`core/models.ts`).

## Geänderte Dateien
- `frontend/src/app/core/nav-counts.ts`
- `frontend/src/app/core/nav-counts.spec.ts`
- `frontend/src/app/app.component.ts`
- `frontend/src/app/app.component.html`
- `frontend/src/styles/02-layout.css`

## Worauf zu achten ist
- Neue Chip-Zustände gehören in `sprintHealthOf` und `sprintStateOf` samt Test, nicht zurück in die Komponente.
- Die Pause hat Vorrang vor „mit Fehlern“, aber nicht vor „Worker offline“ und „fertig“.
- Der Fehlerzustand aus dem Auftrag c30ff9d9 (Git-Verlauf und Sprint-Review) ist nicht berührt.
- Eine Prüfung im Browser steht aus (Sprint pausieren, Kopfzeile und Handy-Ansicht ansehen, fortsetzen).
