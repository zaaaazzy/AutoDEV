# Erneut versuchen: nur in planbare Sprints, Ziel-Sprint atomar

Auftrag 8b554be1 (Bugfix, 25.10.2026). Sprint 23. Gefunden im Code-Review vom 21.10.2026 (Stand `a4971e9`).

## Ursache

- `POST /development/:id/retry` behielt den bisherigen Sprint, solange er nicht `completed` oder `cancelled` war. Ein Sprint im Review galt also als gültig. Der Auftrag lief dann auf dem alten Sprint-Branch.
- „Zurückweisen“ in der Review-Freigabe setzte `auto_run = TRUE`, ließ aber den Sprint unberührt.
- Die Oberfläche buchte einen abgebrochenen Auftrag mit zwei Aufrufen um: erst `/retry` (landet im aktiven Sprint, `auto_run = TRUE`), dann PATCH der Sprint-Zuordnung. Scheiterte der PATCH, blieb der Auftrag im aktiven Sprint, und der Worker konnte ihn sofort starten.

## Umsetzung

- **`retrySprintSql(chosen)`** (`src/api/development.ts`): Ziel-Sprint ist der gewählte, sonst der bisherige, wenn er `planned` oder `active` ist (`ASSIGNABLE_SPRINT_STATUSES`), sonst der älteste aktive Sprint des Projekts, sonst keiner (`main`).
- **`retryAutoRunSql(chosen)`**: `auto_run` folgt dem Ziel-Sprint. Ohne Sprint oder im aktiven Sprint `TRUE`, in einem geplanten `FALSE`. Der Auftrag startet dort erst mit dem Sprintstart.
- **`POST /development/:id/retry`** nimmt optional `{ sprintId }`. Status, Sprint und `auto_run` werden in einem UPDATE gesetzt. Der Bug-Status folgt per Trigger in derselben Anweisung, ein abgelehnter Bug wird also weiter wieder offen.
  - Ungültige ID: 400.
  - Sprint im Review, abgeschlossen, abgebrochen oder aus einem anderen Projekt: 409 („Erneut versuchen nur in geplante oder aktive Sprints desselben Projekts.“), nichts wird geschrieben.
  - Auftrag nicht im erlaubten Ausgangsstatus (z. B. laufend): weiter 409.
- **review-reject** (`src/api/review-routes.ts`) nutzt dieselben Ausdrücke, ohne Wahl. Ein Sprint im Review weicht auf den aktiven Sprint aus.
- **Oberfläche** (`sprint-orders.component.ts`, `takeIntoSprint`): bleibt unverändert. Sie macht schon nur einen Aufruf, `POST /development/:id/take-into-sprint` mit `sprintId`. Diese Route setzt Status, Ziel-Sprint und `auto_run` in einem UPDATE und lässt nur geplante oder aktive Sprints desselben Projekts zu (sonst 409). Das alte Muster (`/retry`, dann PATCH) gibt es dort nicht mehr. Ein Wechsel auf `/retry` würde Logik doppeln. Der neue Parameter `sprintId` an `/retry` steht für andere Aufrufer bereit und ist getestet.

## Geänderte Dateien

- `src/api/development.ts`
- `src/api/review-routes.ts`
- `src/api/development-retry.test.ts` (neu)
- `docs/workflows.md` (Absatz „Sprint beim erneuten Versuch“)

## Tests

`src/api/development-retry.test.ts` (echte PostgreSQL-Datenbank über `withMigratedDatabase`):

- Retry ohne Wahl bei abgeschlossenem, abgebrochenem und Review-Sprint: Auftrag geht in den aktiven Sprint.
- Gegenprobe: geplanter und aktiver Sprint bleiben erhalten.
- `sprintId` mit geplantem Sprint: ein Aufruf, Status und Sprint stehen danach zusammen.
- `sprintId` mit Review-, abgeschlossenem, abgebrochenem und fremdem Sprint: 409, nichts geschrieben.
- Ungültige ID: 400. Laufender Auftrag: 409.
- review-reject aus Review-Sprint und aus geplantem Sprint. Fall ohne aktiven Sprint.

## Worauf zu achten ist

- **Bewusste Entscheidung:** Ohne `sprintId` gibt es keinen 409, sondern den Ausweich auf den aktiven Sprint (wie bisher bei abgeschlossenen und abgebrochenen Sprints). Der 409 gilt nur für eine ausdrücklich gewählte, nicht planbare Wahl.
- **Testergebnis (Projekttestlauf dc145e41):** `npm run typecheck` grün. `src/api/development-retry.test.ts` und `src/api/review-routes.test.ts` zusammen 11 von 11 bestanden, 0 übersprungen. Die Abnahme (DoD 1) blieb offen, weil die Agents die Tests nicht selbst starten durften. Der neue Test braucht PostgreSQL: Ohne Datenbank wird er übersprungen, mit `DEV_LOG_TEST_REQUIRE_DATABASE` schlägt er fehl. Noch nicht gelaufen: `development-status.test.ts` und `sprint-complete.test.ts` (`npx --no-install tsx --test src/api/development-retry.test.ts src/api/development-status.test.ts src/api/sprint-complete.test.ts`).
- **Runner-Auswahl:** `src/runner/runner-selection.ts` ist nicht geändert. Die Hinweise des Bug-Wächters (kein Start in abgeschlossenen oder abgebrochenen Sprints trotz `auto_run`) sind in diesem Stand nicht umgesetzt. Die Verteidigungslinie dort ist offen.
- Neue Aufrufer, die einen Sprint wechseln, geben `sprintId` an `/retry` mit, statt danach zu patchen.

## Sprint 23

| Auftrag | Zustand | Details |
| --- | --- | --- |
| 8b554be1 Erneut versuchen: nur in planbare Sprints, Ziel-Sprint atomar | umgesetzt, typecheck und Retry-Tests grün (11/11), Abnahme DoD 1 offen | Retry und review-reject nur in planned/active, `sprintId` in einem UPDATE, 409 sonst; neuer API-Test, Doku in `workflows.md` |

## Anfrage / TODO

- Tester: Lauf dc145e41 (11/11, typecheck grün) für DoD 1 werten; `development-status.test.ts` und `sprint-complete.test.ts` mit PostgreSQL nachziehen.
- Reviewer / Entwickler: prüfen, ob `selectItems` in `runner-selection.ts` zusätzlich Aufträge in abgeschlossenen oder abgebrochenen Sprints ausschließen soll (zweite Verteidigungslinie).
