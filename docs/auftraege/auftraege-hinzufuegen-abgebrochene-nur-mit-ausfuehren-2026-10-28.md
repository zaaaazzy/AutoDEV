# Aufträge hinzufügen: abgebrochene Aufträge nur mit Recht „Ausführen“

Auftrag 65ecb969 (Bugfix, Sprint 23). Aus dem Code-Review vom 21.10.2026 (Stand `a4971e9`).

## Problem

„Aufträge hinzufügen“ auf der Sprintseite bot blockierte und aus dem Sprint genommene („abgebrochene“) Aufträge schon mit der Rolle `plan` an. Das Neueinplanen ist aber ein erneuter Versuch wie `POST /retry`, der die Rolle `run` braucht (`src/api/roles.ts`). Ein Planer ohne `run` konnte die Aufträge anhaken und bekam je Auftrag einen Fehler, der stumm in der Liste „nicht übernommen“ landete.

Die eigentliche Lücke lag in der Route `POST /api/development/:id/take-into-sprint`: Sie verlangte nur `plan` und setzte abgebrochene Aufträge damit auch ohne `run` zurück. Die Oberfläche allein abzusichern hätte nicht gereicht.

## Umsetzung

### Server (`src/api/development.ts`)

- `take-into-sprint` ermittelt `canRun` über `hasRole(principal, 'run')` und reicht es als Parameter `$3` in dieselbe UPDATE-Abfrage: `AND ($3::boolean OR NOT <abgebrochen>)`. Ohne `run` greift das UPDATE bei abgebrochenen Aufträgen nicht, die Prüfung ist atomar mit dem Zurücksetzen.
- Blieb das UPDATE ohne Treffer und fehlt `run`, prüft eine zweite Abfrage nur für die Meldung, ob der Auftrag abgebrochen ist. Dann antwortet die Route mit **403**: „Abgebrochene Aufträge neu einplanen braucht die Rolle „Agents ausführen“.“ Sonst bleibt es beim bisherigen 409.
- Offene Aufträge bleiben mit `plan` übernehmbar. `/retry` ist unverändert (403 ohne `run`).

### Oberfläche (`frontend/src/app/features/sprints/`)

- `pool-selection.ts`: neue Regel, welche Aufträge ohne `run` gesperrt sind; angehakte, nun gesperrte Aufträge fallen aus der Auswahl (z. B. bei Rollenwechsel).
- `sprint-orders.component.ts/.html`: nutzt `auth.can('run')`. Abgebrochene Aufträge haben ohne `run` kein Häkchen, der Knopf „→“ ist deaktiviert, und über der Liste steht ein Hinweis, der das fehlende Recht nennt. Mit `run` ist alles wie zuvor auswählbar.

### Vorbedingung

„Erneut versuchen: nur in planbare Sprints, Ziel-Sprint atomar“ (`/retry` mit `sprintId`) war bereits umgesetzt, siehe `erneut-versuchen-nur-planbare-sprints-2026-10-25.md`.

## Worauf zu achten ist

- Der Server bleibt maßgeblich. Die Oberfläche zeigt nur dieselbe Regel; ändert sich die Rechteregel von `/retry`, muss `take-into-sprint` mitgezogen werden.
- „Abgebrochen“ heißt hier: `removed_from_sprint_at IS NOT NULL` oder Status `blocked`. Dieselbe Bedingung (`aborted`) steckt im UPDATE und in der Meldungsabfrage.
- Nur `plan` ohne `run` sieht abgebrochene Aufträge weiter in der Liste, kann sie aber nicht auswählen.

## Tests

- `src/api/development-status.test.ts`: `take-into-sprint` mit `plan` ohne `run` (abgebrochen → 403, offen → übernommen) und mit `run`.
- `frontend/src/app/features/sprints/pool-selection.spec.ts`: Sperre ohne `run`, Auswahl mit `run`, gemischte Auswahl und Rollenwechsel.

Ausgeführt wurden die Tests von der Dokumentation nicht erneut.

## Geänderte Dateien

- `src/api/development.ts`, `src/api/development-status.test.ts`
- `frontend/src/app/features/sprints/pool-selection.ts`, `pool-selection.spec.ts`
- `frontend/src/app/features/sprints/sprint-orders.component.ts`, `sprint-orders.component.html`
- `docs/laufzeit.md` (Abschnitt zu „Aufträge hinzufügen“)

## Offen für das Benutzerhandbuch

Bei „Aufträge hinzufügen“ ergänzen: Abgebrochene Aufträge lassen sich nur mit der Rolle „Agents ausführen“ übernehmen.
