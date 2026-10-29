# Abnahme-Häkchen nach Fehler zurücksetzen

Auftrag 3a3acdb4 (Bugfix, Sprint 23). Aus dem Code-Review vom 21.10.2026 (Stand `a4971e9`).

## Problem

- Die Häkchen der offenen Abnahmepunkte unter „Aktionen“ (`actions.component.html`) und im Auftragsdetail (`order-detail.component.html`, „Noch zu erledigen“) waren mit `[checked]="false"` gebunden. Der gebundene Wert änderte sich nie, deshalb setzte Angular den DOM-Zustand nach einem Fehler nicht zurück.
- Bei 403, 409 oder Netzfehler blieb das Häkchen gesetzt. Die Meldung verschwand nach 5 s, danach sah der Punkt geprüft aus.
- `store.perform` schluckt Fehler, `OrderService.checkPoint` gab nichts zurück. Die Komponente konnte deshalb nicht erkennen, ob das Speichern geklappt hat.
- Das Häkchen war auch ohne das Recht „Planung“ bedienbar. Der Server (`access({ role: 'plan' })`) lehnte dann mit 403 ab.

## Umsetzung

- `ProjectStore.perform` gibt jetzt `true` oder `false` zurück. Die Fehlerbehandlung bleibt gleich: Die Meldung erscheint oben. Bisherige Aufrufer ignorieren den Rückgabewert, darum ist `exclusive` in `sprint-actions.ts` jetzt auf `Promise<unknown>` gelockert.
- `OrderService.checkPoint` gibt das Ergebnis von `perform` weiter.
- Neu ist `frontend/src/app/shared/acceptance-ticks.ts` (`AcceptanceTicks`). Die Klasse merkt sich je Punkt (Auftrag, Art, Position), ob er gerade gespeichert wird:
  - `[checked]="ticks.saving(item.id, check)"`: Während des Speicherns ist das Häkchen gesetzt, danach wieder leer.
  - Nach einem Fehler setzt `tick()` zusätzlich `checked = false` direkt im DOM.
  - Ein zweiter Klick während des Speicherns sendet nichts.
  - Bei Erfolg verschwindet der Punkt nach dem Nachladen aus der Liste der offenen Punkte.
- Beide Häkchen sind ohne `auth.can('plan')` gesperrt. Ein Tooltip nennt dann das fehlende Recht.

## Bedienung

Wer das Recht „Planung“ nicht hat, sieht die offenen Abnahmepunkte weiterhin. Das Häkchen ist aber ausgegraut. Schlägt das Abhaken fehl, wird das Häkchen wieder leer, und oben erscheint die Fehlermeldung.

## Tests

`frontend/src/app/shared/acceptance-ticks.spec.ts` prüft:

- Nach 403, 409 und Netzfehler ist das Häkchen wieder leer.
- Bei Erfolg bleibt es gesetzt, und der Speicher-Zustand gilt nur für den jeweiligen Punkt.
- Ein Doppelklick sendet nur einen Aufruf.
- Beide Vorlagen binden Zustand und Recht. Gegen die alten Vorlagen mit `[checked]="false"` scheitert dieser Test.
