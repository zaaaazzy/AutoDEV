# „Aufträge hinzufügen“ bleibt beim Daten-Refresh offen

Auftrag 27a54f19 (Bugfix) aus der Gesamtprüfung vom 21.10.2026. Stand: 22.10.2026. Der Auftrag betrifft nur das Frontend.

## Problem
Die Liste „Aufträge hinzufügen“ im Sprint klappte zu, sobald sich `store.data()` änderte. Das passiert alle 3 s (`refreshLiveRuns`, solange ein Agent läuft) und nach jedem „→“. `orders()` liefert dann ein neues Array. Das `linkedSignal` hing direkt daran und fiel auf „zu“ zurück. `@if (poolOpen())` zerstörte dabei Tabelle, Filter und Auswahl.

## Was umgesetzt wurde
- Der Offen-Zustand steckt in `poolOpenState(orders)` in `pool-selection.ts`. Quelle des `linkedSignal` ist nur der Boolean „Sprint leer ja/nein“ (`computed`). Neue Arrays mit gleichem Inhalt und geänderte `agentRuns` setzen die Wahl des Nutzers nicht mehr zurück.
- Vorgabe unverändert: bei leerem Sprint offen, sonst zu. Wechselt der Sprint zwischen leer und nicht leer, gilt wieder die Vorgabe.
- `sprint-orders.component.ts` ruft nur noch `poolOpenState(this.orders)` auf.
- `project-store.ts` und das Template sind unverändert.

## Geänderte Dateien
- `frontend/src/app/features/sprints/pool-selection.ts`
- `frontend/src/app/features/sprints/pool-selection.spec.ts`
- `frontend/src/app/features/sprints/sprint-orders.component.ts`

## Tests (`pool-selection.spec.ts`)
1. Anfangszustand: leer offen, sonst zu.
2. Von Hand geöffnet bleibt offen bei neuem Array, geänderten `agentRuns` und nach „→“. Die Auswahl bleibt erhalten, nur der übernommene Auftrag fällt heraus.
3. Refresh im leeren Sprint ändert die Wahl nicht. Wechsel leer ↔ nicht leer setzt auf die Vorgabe zurück.

Mit der alten Variante `linkedSignal(() => !orders().length)` schlagen Test 2 und 3 fehl.

## Worauf zu achten ist
- Der Fix war im Kern schon seit c2165fa im Code. Der Auftrag liefert die Auslagerung und die Regressionstests.
- Neue Zustände für die Liste gehören in `poolOpenState`, nicht direkt an `orders()`.
- `project-store.ts` wird auch von Auftrag 5 („Status nach Ende eines Laufs“) geändert. Beide Aufträge nacheinander mergen.
