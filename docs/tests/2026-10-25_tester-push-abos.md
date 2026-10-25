# Tester: Push-Abos (Auftrag 7ec815c1), 2026-10-25

## Lauf 1 (vor dem Fix)
`npm test`: 1443 Tests, 1442 bestanden, 1 rot.

- Alle Push-Tests grün (`src/api/push.test.ts`, `src/core/push.test.ts`, `src/runner/watchdog.test.ts`). Der Testwert nutzt bereits einen erlaubten Push-Dienst, die Übernahme-Prüfung ist an die Besitzregel angepasst.
- Rot: `src/api/app.test.ts:608` „assigns development orders to sprints only within the same project“ (404 statt 400).

## Bug
Der Test ist veraltet, nicht der Code. Seit dem Auftrag „Sprint-Auswahl im Auftrag hängt laufende und erledigte Aufträge um“ (36dd6660) liest `PATCH /development/:id` zuerst den Auftrag. Die Mock-Datenbank lieferte keine Zeile und löste damit 404 aus. Der Push-Auftrag hat damit nichts zu tun, ist aber ein Test-Gate-Fehler.

## Fix
Der Mock liefert zuerst den Auftrag (`backlog`, ohne Sprint), danach keinen Sprint. Erwartet werden 400 und zwei Abfragen. Die Prüfung auf die Projektgrenze in der zweiten Abfrage bleibt.

## Lauf 2 (nach dem Fix)
`npm test`: 1443 Tests, 1443 bestanden, 0 rot. Bug damit behoben.
