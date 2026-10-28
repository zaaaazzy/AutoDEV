# „Aufträge hinzufügen“ klappt bei jedem Daten-Refresh zu

Auftrag 9102659f (Bugfix, Schwere hoch, 25.10.2026). Sprint 23. Gemeldet vom Tester.

## Ursache

1. **Die gemeldeten Testfehler gehören nicht zu diesem Auftrag.** Sie liegen im Backend (`src/runner/git-sync/secret-holdback.test.ts`, `src/runner/sprint-reviews-live.test.ts:48` und `:59`, `src/runner/report-copies.test.ts:80`). Der Auftrag betrifft nur `frontend/src/app/features/sprints/`. Die Tests waren schon vorher rot und sind hier nicht behoben.
2. **Der eigentliche Fehler im Frontend:** Der Offen-Zustand von „Aufträge hinzufügen“ hing als `linkedSignal` an der Auftragsliste des Sprints. Die Liste ist bei jedem Nachladen (Agent-Läufe alle 3 s, Commits) ein neues Array. Das `linkedSignal` rechnete dann neu und setzte eine von Hand geöffnete Liste auf die Vorgabe zurück, also zu.

## Umsetzung

- **`pool-selection.ts`:** Neue Funktion `poolOpenState(orders)`. Quelle des `linkedSignal` ist nur noch `computed(() => !orders().length)`, also „Sprint leer ja/nein“. Ein neues Array mit gleichem Leer-Zustand löst deshalb keine Neuberechnung aus. Erst der Wechsel leer ↔ nicht leer setzt wieder auf die Vorgabe (leer: offen, sonst zu). Von Hand lässt sich der Zustand weiter ändern.
- **`sprint-orders.component.ts`:** `poolOpen = poolOpenState(() => this.orders())`. Das eigene `sprintEmpty`-Signal und der `linkedSignal`-Import entfallen.
- **Test (`pool-selection.spec.ts`, +68 Zeilen):** Drei Fälle mit einem Signal für die Auftragsliste:
  1. Vorgabe: leerer Sprint offen, gefüllter Sprint zu.
  2. Eine von Hand geöffnete Liste bleibt bei einem Refresh mit neuem Array offen. Sie bleibt auch offen, wenn neu geladen wird oder ein Auftrag übernommen wird.
  3. Ein Refresh im leeren Sprint ändert die Wahl nicht. Der Wechsel leer ↔ nicht leer setzt auf die Vorgabe zurück.

  Mit der alten Fassung `linkedSignal(() => !orders().length)` scheitern Test 2 und 3 beim ersten Refresh.

## Geänderte Dateien

- `frontend/src/app/features/sprints/pool-selection.ts`
- `frontend/src/app/features/sprints/pool-selection.spec.ts`
- `frontend/src/app/features/sprints/sprint-orders.component.ts`

## Worauf zu achten ist

- **Test nicht gelaufen:** Der Entwickler durfte ihn nicht ausführen (Freigabe fehlte), nur `npm run typecheck` lief fehlerfrei. Der Tester soll gezielt `npx --no-install tsx --test frontend/src/app/features/sprints/pool-selection.spec.ts` starten, ohne Abdeckungs-Flags und ohne die ganze Suite.
- **Rote Backend-Tests bleiben:** Bei `sprint-reviews-live.test.ts` fehlt in der Meldung der Text „offene Änderungen – dort mit „git pull“ übernehmen“. Dazu kommen `secret-holdback` und `report-copies:80`. Sie brauchen einen eigenen Backend-Auftrag und sind kein Beleg gegen diesen Fix.
- **Regel für ähnliche Fälle:** Ein Zustand, der aus einer Liste abgeleitet wird, darf nicht direkt an der Liste hängen, wenn diese bei jedem Laden neu entsteht. Als Quelle dient der abgeleitete Wert (`computed`).
- Der Auftragsstatus wurde nicht von Hand gesetzt. Die serverseitige Sperre für das Umhängen laufender oder erledigter Aufträge (Sprint 23, Auftrag 3) ist nicht Teil dieses Auftrags.

## Sprint 23

| Auftrag | Zustand | Details |
| --- | --- | --- |
| 9102659f „Aufträge hinzufügen“ klappt bei Daten-Refresh zu | umgesetzt, Test wartet auf Tester | `poolOpenState` in `pool-selection.ts`, 3 neue Testfälle, 3 Dateien geändert |

## Anfrage / TODO

- Test `pool-selection.spec.ts` ausführen und das Ergebnis bestätigen.
- Neuer Auftrag (Backend, Schwere mittel): `secret-holdback.test.ts`, `sprint-reviews-live.test.ts` (Zeilen 48, 59) und `report-copies.test.ts:80` prüfen und beheben.

## Technische Dokumentation

Das Verhalten steht in `frontend/src/app/features/sprints/pool-selection.ts` (Kommentar an `poolOpenState`). Die Backend-Seite von „Aufträge hinzufügen“ (`POST /api/development/:id/take-into-sprint`) steht in `docs/laufzeit.md` und ist unverändert.
