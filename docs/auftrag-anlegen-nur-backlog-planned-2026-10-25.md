# Auftrag anlegen nur mit Status backlog oder planned

Auftrag 39ad59ba (Bugfix, 25.10.2026). Sprint 23. Gefunden im Code-Review vom 21.10.2026 (Stand `a4971e9`).

## Ursache

`POST /api/projects/:slug/development` prüfte den Status gegen alle Werte aus `DEVELOPMENT_STATUSES`. Die Übergangstabelle gilt nur für `PATCH`. Wer anlegen durfte (z. B. die Rolle „plan“), konnte einen Auftrag direkt als `done`, `approval` oder `in_progress` erzeugen:

- `done` verfälscht Velocity und Burndown und erlaubt Folgeaufträge.
- `approval` erscheint in der Freigabeliste. „Freigeben“ ließ den Worker dann einen nicht existierenden Branch mergen.

## Umsetzung

- **Neue Konstante** `NEW_ORDER_STATUSES` (`src/api/development.ts`): nur `backlog` und `planned`.
- **Feldtabelle** `NEW_ORDER_FIELDS.status` nutzt `parseOption(NEW_ORDER_STATUSES)`. `DEV_FIELDS` bleibt unverändert, weil `PATCH` es mit allen Status weiter braucht.
- **Vorabprüfung im POST-Handler** nutzt dieselbe Konstante statt `DEVELOPMENT_STATUSES`. Jeder andere Status ergibt 400 mit Feld `status`, und es wird nichts in `development_items` geschrieben.
- **Ohne Status** entsteht weiter `backlog` (`COALESCE($6, 'backlog')`).
- **Doku:** `docs/workflows.md` nennt jetzt die beim Anlegen erlaubten Status.
- **Aufrufer:** Niemand legt Aufträge mit anderem Status an. E2E-Tests und das Formular (`development.component.ts`) senden `backlog` oder keinen Status.

## Geänderte Dateien

- `src/api/development.ts`
- `src/api/development-create.test.ts` (neu)
- `docs/workflows.md`

## Tests

`src/api/development-create.test.ts` (Datenbank als Attrappe, Muster von `development-status.test.ts`):

- `done`, `approval`, `in_progress`, `blocked`, `rejected` → 400, Feld `status`, kein Schreibzugriff.
- Ohne Status → 201 mit `backlog`. `backlog` und `planned` → 201 mit genau diesem Status.

## Worauf zu achten ist

- **Tests noch nicht gelaufen:** Der Wächter hielt alle Testläufe zurück. Der Tester soll gezielt `npx --no-install tsx --test src/api/development-create.test.ts src/api/development-status.test.ts` ohne Coverage-Flags und `npm run typecheck` starten.
- `DEV_FIELDS` nicht verengen, sonst bricht `PATCH`.
- Wer künftig einen Auftrag in einem anderen Status braucht, legt ihn an und schaltet per `PATCH` (Übergangstabelle) weiter.

## Sprint 23

| Auftrag | Zustand | Details |
| --- | --- | --- |
| 39ad59ba Auftrag anlegen nur mit Status backlog oder planned | umgesetzt, Tests warten auf Tester | POST erlaubt nur `backlog`/`planned`, sonst 400; neuer API-Test, Doku in `workflows.md` |

## Anfrage / TODO

- Tester: die beiden genannten Testdateien und `npm run typecheck` ausführen und das Ergebnis bestätigen.
