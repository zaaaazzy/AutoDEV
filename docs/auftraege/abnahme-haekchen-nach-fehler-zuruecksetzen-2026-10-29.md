# Abnahme-Häkchen nach Fehler zurücksetzen

Auftrag 3a3acdb4 (Bugfix, Sprint 28). Aus dem Code-Review vom 21.10.2026 (Stand `a4971e9`).

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

## Geänderte Dateien

- `frontend/src/app/shared/acceptance-ticks.ts` (neu): Klasse `AcceptanceTicks`
- `frontend/src/app/shared/acceptance-ticks.spec.ts` (neu)
- `frontend/src/app/core/project-store.ts`: `perform` gibt `Promise<boolean>` zurück
- `frontend/src/app/features/development/order.service.ts`: `checkPoint` gibt das Ergebnis weiter
- `frontend/src/app/features/actions/actions.component.html` und `.ts`
- `frontend/src/app/features/development/order-detail.component.html` und `.ts`
- `frontend/src/app/features/development/order-visual.component.ts`
- `frontend/src/app/features/sprints/sprint-actions.ts`: `exclusive` auf `Promise<unknown>` gelockert

Backend, API und Datenbank sind unverändert.

## Sprint

| Auftrag | Titel | Art | Sprint | Zustand |
|---|---|---|---|---|
| 3a3acdb4 | Abnahme-Häkchen auf „Aktionen“ nach Fehler zurücksetzen | Bugfix | Sprint 28 | umgesetzt (Entwickler), dokumentiert; Tests ausgeführt und grün |

## Anfrage / TODO

- Anfrage: Code-Review vom 21.10.2026 (Stand `a4971e9`). Gemeldet war nur die Stelle unter „Aktionen“ (Zeile 206–212). Tatsächlich stand das Häkchen dort bei Zeile 49–55; dasselbe Muster steckte auch im Auftragsdetail und wurde mit behoben.
- Benutzerhandbuch: Das Häkchen ist ohne Recht „Planung“ ausgegraut (Tooltip) und wird nach einem Fehler wieder leer. Übernimmt der Benutzerhandbuch-Autor.
- Tests ausgeführt (29.10.2026): `npm run test:unit` mit 1782 Tests, davon 1777 bestanden, 0 fehlgeschlagen. Alle sechs „Abnahme-Häkchen“-Tests aus `acceptance-ticks.spec.ts` sind grün (403, 409, Netzfehler, Erfolg, Doppelklick, Vorlagen). Im Testlauf cb63990a waren `npm run typecheck` und `acceptance-ticks.spec.ts` mit `sprint-actions.spec.ts` grün (13/13).

## Technische Dokumentation

- `ProjectStore.perform(action, success, refresh = true): Promise<boolean>` fängt Fehler weiterhin ab und zeigt die Meldung. Neu: `true` bei Erfolg, `false` bei Fehler. Wer nur bei Erfolg weitermachen will, nutzt diesen Wert.
- `AcceptanceTicks` führt je Punkt (Auftrag, Art, Position) einen Zustand „wird gespeichert“. `saving(id, check)` wird an `[checked]` gebunden. `tick()` sperrt Doppelklicks und setzt im Fehlerfall `checked = false` direkt im DOM, weil sich der gebundene Wert sonst nicht ändert und Angular nichts zurücksetzt.
- Die Sperre ohne `auth.can('plan')` ist nur Bedienkomfort. Maßgeblich bleibt `access({ role: 'plan' })` auf dem Server.

## Worauf zu achten ist

- Neue Checkboxen mit Speichern über die API nie mit festem `[checked]="false"` binden.
- Die früheren „offenen“ Bug-Wächter-Einträge („monthly spend limit“) sind reine Abbrüche durch das Kostenlimit und haben mit diesem Code nichts zu tun.
