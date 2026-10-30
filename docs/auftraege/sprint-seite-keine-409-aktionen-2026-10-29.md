# Sprint-Seite bietet keine Aktionen mehr an, die der Server mit 409 ablehnt

Auftrag d923faa6 (Bugfix, Sprint 28, Schwere niedrig). Gefunden bei der Gesamtprüfung vom 21.10.2026 (Bereich: frontend).

## Problem

Auf der Sprint-Seite konnte man Aktionen anstoßen, die der Server sicher mit 409 ablehnt:

- „Sprint starten“ und „Wieder öffnen“ erschienen auch dann, wenn schon ein anderer Sprint aktiv war. Antwort: „Es kann nur ein Sprint pro Projekt aktiv sein.“
- „Live schalten“ erschien auch bei laufenden Aufträgen (`in_progress`). Antwort: „Im Sprint laufen noch Aufträge.“
- „Löschen“ stand zeitweise bei `active` und `review`.

## Stand vor der Änderung

Ein Teil war schon durch `sprintButtons()` in `sprint-actions.ts` gelöst, das die gemeinsamen Regeln aus `src/core/sprint-rules.ts` nutzt (siehe `sprint-regeln-teilen-knoepfe-nur-wenn-erlaubt-2026-10-28.md`):

- „Löschen“ (`remove`) kommt aus `canDeleteSprint`, also nicht bei `active` und `review`.
- „Live schalten“ hatte schon `liveBlocked`.
- „Sprint starten“ und „Wieder öffnen“ wurden bei einem anderen aktiven Sprint ausgeblendet statt gesperrt. Gewünscht war Deaktivieren mit Hinweis.

## Umsetzung

- `src/core/sprint-rules.ts`: neue Konstante `ONE_ACTIVE_SPRINT_MESSAGE` (Text der 409-Meldung).
- `src/api/sprints.ts`: Die lokale Konstante `ONE_ACTIVE_MESSAGE` wurde entfernt. Der Server importiert die gemeinsame Konstante. Text und Verhalten sind unverändert.
- `sprint-actions.ts`: `sprintButtons()` liefert ein neues Feld `activateBlocked` (`string | null`). `start` und `reopen` werden jetzt ohne Berücksichtigung des anderen aktiven Sprints berechnet. Ist ein anderer Sprint aktiv, steht in `activateBlocked` die Servermeldung.
- `sprint-detail.component.html`: „Sprint starten“ und „Wieder öffnen“ sind mit `[disabled]="busy() || !!can.activateBlocked"` gesperrt und zeigen den Grund als Tooltip (`[attr.title]`).
- „Live schalten“ ist wie zuvor gesperrt, solange ein Auftrag läuft (`liveBlocked`).

## Bedienung

- Ist Sprint A aktiv, bleibt „Sprint starten“ in Sprint B sichtbar, ist aber ausgegraut. Der Tooltip nennt den Grund.
- „Wieder öffnen“ bei einem abgeschlossenen Sprint verhält sich genauso.
- Bei aktivem oder im Review befindlichem Sprint gibt es kein „Löschen“.
- Ohne das Recht „Planung“ erscheinen die Knöpfe weiterhin nicht.

## Tests

- `frontend/src/app/features/sprints/sprint-phases.spec.ts`: neuer Regressionstest. Er prüft: kein „Löschen“ bei `active` und `review`; „Sprint starten“ in B ist sichtbar, aber gesperrt (`activateBlocked`), solange A aktiv ist; „Live schalten“ ist gesperrt (`liveBlocked`), solange ein Auftrag `in_progress` ist.
- `sprint-actions.spec.ts`: Die alten Erwartungen „Knopf verschwindet“ wurden auf „sichtbar, aber gesperrt mit Grund“ umgestellt.

## Geänderte Dateien

- `src/core/sprint-rules.ts`
- `src/api/sprints.ts`
- `frontend/src/app/features/sprints/sprint-actions.ts`
- `frontend/src/app/features/sprints/sprint-actions.spec.ts`
- `frontend/src/app/features/sprints/sprint-detail.component.html`
- `frontend/src/app/features/sprints/sprint-phases.spec.ts`

Datenbank und API-Verträge sind unverändert.

## Worauf achten

- Neue Sperrgründe gehören in `sprint-rules.ts` und werden über `sprintButtons()` ins Template gereicht. Keine Regeln im Template nachbauen.
- Wer das Verhalten ändert, passt `sprint-actions.spec.ts` und den Regressionstest in `sprint-phases.spec.ts` an.

## Sprint

| Auftrag | Titel | Art | Sprint | Zustand |
|---|---|---|---|---|
| d923faa6 | Sprint-Seite bietet Aktionen an, die der Server immer mit 409 ablehnt | Bugfix | Sprint 28 | umgesetzt (Entwickler), dokumentiert; Tests in diesem Schritt nicht neu ausgeführt |

## Anfrage / TODO

- Anfrage: Gesamtprüfung vom 21.10.2026 (frontend). Ein Teil war bereits behoben, ergänzt wurde das Sperren statt Ausblenden und der Regressionstest.
- Benutzerhandbuch: „Sprint starten“ und „Wieder öffnen“ bleiben bei einem anderen aktiven Sprint sichtbar, sind gesperrt und zeigen einen Tooltip. Übernimmt der Benutzerhandbuch-Autor.
