# Sprint-Regeln teilen: Knöpfe nur zeigen, wenn Server und Rolle sie erlauben

Auftrag eb3986f5 (Bugfix, Sprint 23). Aus dem Code-Review vom 21.10.2026 (Stand `a4971e9`).

## Problem

- Das Sprint-Detail zeigte „Löschen“, „Live schalten“, „Sprint starten“ und „Wieder öffnen“ unabhängig von Status, laufenden Aufträgen, anderem aktivem Sprint und Rolle. Die Regeln (`SPRINT_TRANSITIONS`, Lösch-Bedingung) lagen nur im Server, die Komponente fragte keine Rechte ab.
- Man klickte einen sichtbaren Knopf und bekam nur 409 oder 403. Ein Doppelklick auf „Sprint starten“ schickte einen zweiten PATCH.

## Umsetzung

### Gemeinsame Regeln (`src/core/sprint-rules.ts`)

Neue Datei ohne Importe, von Server und Oberfläche genutzt:

- `SPRINT_TRANSITIONS` (unverändert aus `sprints.ts` verschoben), `canChangeSprintStatus`.
- Lösch-Regel: `DELETABLE_SPRINT_STATUSES`, `IDLE_SPRINT_GIT_SYNC`, `SPRINT_HOLDING_DEVELOPMENT_STATUSES`, `canDeleteSprint`.
- Abschluss: `completeSprintConflict(running, waiting)` liefert die Meldung oder `null`; `canCompleteSprint`.
- Ein aktiver Sprint pro Projekt: `hasOtherActiveSprint`, `canActivateSprint`.

### Server (`src/api/sprints.ts`)

- PATCH nutzt `canChangeSprintStatus` und `completeSprintConflict`; die SQL-Bedingung von DELETE wird aus den gemeinsamen Statuslisten gebaut (`sqlList`, nur feste Konstanten).
- **Neu:** Beim Wechsel nach `active` (Start, Wieder öffnen) prüft der Server vorab, ob im Projekt schon ein anderer Sprint aktiv ist, und antwortet 409 „Es kann nur ein Sprint pro Projekt aktiv sein.“ vor dem Git-Check. Bisher kam das erst über den Unique-Index (23505, bleibt als Absicherung).
- Der Server prüft weiter selbst und liefert 409/403; die Oberfläche zeigt nur dieselben Regeln.

### Oberfläche (`frontend/src/app/features/sprints/`)

- `sprint-actions.ts`: `sprintButtons(sprint, sprints, items, can)` bestimmt je Knopf die Sichtbarkeit. Rechte: PATCH/DELETE brauchen „Planung“ (`auth.can('plan')`), Pausieren/Fortsetzen „Ausführen“ (`auth.can('run')`). „Live schalten“ bleibt sichtbar, ist aber ausgegraut und nennt den Grund (`liveBlocked`), solange Aufträge laufen oder auf Freigabe warten.
- `exclusive(flag, action)`: sperrt ab dem ersten Klick (auch während der Rückfrage) und setzt das Flag im `finally` zurück. So gehen die Knöpfe nach einem Fehler wieder.
- `sprint-detail.component.ts/.html`: nutzt `AuthService`, `sprintButtons` und `exclusive`; alle Knöpfe sind mit `busy()` gesperrt.

### Build

Das Frontend-Image kopiert geteilte `src/core`-Dateien einzeln: `sprint-rules.ts` steht in `deploy/frontend/Dockerfile`, `frontend/tsconfig.app.json` und `frontend/tsconfig.spec.json`.

## Worauf zu achten ist

- Neue Importe in `sprint-rules.ts` brauchen ebenfalls Einträge im Dockerfile und in den tsconfig-Dateien.
- Änderungen an den Sprint-Regeln gehören nur in `sprint-rules.ts`, sonst laufen Server und Knöpfe wieder auseinander.
- Ein Benutzer nur mit „Ausführen“ sieht im Sprint-Detail nur Pausieren und Fortsetzen.

## Tests

- `src/core/sprint-rules.test.ts`: Übergänge, Lösch-Regel, Abschluss, anderer aktiver Sprint.
- `frontend/src/app/features/sprints/sprint-actions.spec.ts`: Knöpfe je Rolle und Zustand, Doppelklick sendet nur einen Aufruf, Flag nach Fehler zurückgesetzt.

Ausgeführt wurden die Tests von der Dokumentation nicht erneut.

## Geänderte Dateien

- `src/core/sprint-rules.ts`, `src/core/sprint-rules.test.ts`
- `src/api/sprints.ts`
- `frontend/src/app/features/sprints/sprint-actions.ts`, `sprint-actions.spec.ts`
- `frontend/src/app/features/sprints/sprint-detail.component.ts`, `sprint-detail.component.html`
- `frontend/tsconfig.app.json`, `frontend/tsconfig.spec.json`
- `deploy/frontend/Dockerfile`
- `docs/benutzerhandbuch-regeln-auftraege-sprints-bugs.md` (Bedienung)
