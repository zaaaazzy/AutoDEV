# API-Tests für Aufträge, Sprints und Bugs

Auftrag b8004e48 (25.10.2026), Sprint 23. Gefunden im Code-Review vom 21.10.2026 (Stand `a4971e9`).

## Ausgangslage

Für viele Regeln gab es schon Tests, meist mit einer Pool-Attrappe: `development-status.test.ts`, `development-create.test.ts`, `development-retry.test.ts`, `sprint-complete.test.ts`, `bugs.test.ts` und `app.test.ts`. Eine Attrappe prüft aber nur Statuscode und SQL-Text. Ob der Datenbankstand und die Trigger stimmen, sieht sie nicht.

## Neu: `src/api/order-sprint-bug-routes.test.ts`

Der Test läuft gegen eine echte, frisch migrierte PostgreSQL-Datenbank (`withMigratedDatabase`). Jeder Teiltest bekommt ein eigenes Projekt, also gibt es keine Abhängigkeit von der Reihenfolge. Je Regel gibt es einen erlaubten und einen abgelehnten Fall. Bei Ablehnungen vergleicht der Test die ganze Zeile vorher und nachher, auch `updated_at` und `git_sync`.

| Regel | Erlaubt | Abgelehnt |
| --- | --- | --- |
| Anlegen | `planned` → 201 | `in_progress`, `approval`, `done`, `blocked`, `rejected` → 400, keine Zeile |
| PATCH Status | `planned` → `backlog` | `done` → `planned` → 409, Zeile unverändert |
| PATCH Sprint | geplanter Sprint, `auto_run` geht zurück | abgeschlossener Sprint; laufender Auftrag lösen → 409 |
| Retry | abgelehnter Bug-Auftrag: Auftrag `planned`, Bug wieder `open` (Trigger); blockierter: `retry_count` + 1 | zweiter Retry, Express-Auftrag → 409, Auftrag und Bug unverändert |
| review-reject | Freigabe → `planned`, Rückmeldung in der Beschreibung, Bug `in_progress` → `open` | ohne Kommentar 400; schon freigegeben oder `in_progress` → 409 |
| remove-from-sprint | geplanter Auftrag aus aktivem Sprint, mit Vermerk | laufender Auftrag, abgeschlossener Sprint → 409 |
| Folgeauftrag | zu erledigtem Auftrag in geplanten Sprint | Quelle nicht erledigt, fremder Sprint, leerer Titel → 400; abgebrochener Sprint → 409 |
| Sprint abschliessen | ohne laufende Aufträge: Bericht und `git_sync = pending` | mit laufendem Auftrag → 409, kein Git-Sync; Sprint im Review → 409 |
| Sprint wieder öffnen | `completed` → `active` (ohne Git-Sync), `cancelled` → `planned` | `cancelled` → `active`, `completed` → `planned`, zweiter aktiver Sprint → 409 |
| Sprint löschen | geplanter: Aufträge zurück ins Backlog | aktiver, mit Auftrag in Freigabe oder laufender Git-Sicherung → 409, Aufträge unverändert |
| Bug-Zuordnung | alle Quellen (`manual`, `agent`, `test`, `production`, `github`, `routine`) in geplante und aktive Sprints; fremde Quellen ohne Auftrag vor der Freigabe | Sprint im Review, abgeschlossen oder abgebrochen → 409, kein Auftrag |
| Bug anlegen | mit aktivem Sprint, Auftrag entsteht | mit abgeschlossenem Sprint → 409, kein Bug |

## Ausführen

Nur über `npm test`. Ohne erreichbare Datenbank wird der Test übersprungen, mit `DEV_LOG_TEST_REQUIRE_DATABASE` schlägt er fehl.

## Nicht abgedeckt

- **Laufende Bug-Aufträge nicht umhängen:** Der Fix dafür (Auftrag 172c4f29) liegt noch auf einem eigenen Zweig. Im aktuellen Stand hängt `syncBugOrder` einen Auftrag in `in_progress` beim Sprintwechsel des Bugs mit um. Ein Test dafür wäre hier rot und gehört zum Fix-Zweig.
- **Bug im abgeschlossenen Sprint bearbeiten:** Ändert man den Titel eines solchen Bugs, legt `syncBugOrder` einen geplanten Auftrag im abgeschlossenen Sprint an, den der Worker nie mehr aufnimmt. Der Test prüft hier nur, dass das Speichern klappt. Das Verhalten sollte ein eigener Auftrag klären.

## Geänderte Dateien

- `src/api/order-sprint-bug-routes.test.ts` (neu, 12 Teiltests, PostgreSQL)
- `docs/api-tests-auftraege-sprints-bugs-2026-10-25.md` (neu)

Code unter `src/` ausser dem Test ist unverändert. Es gibt keine Schema- oder API-Änderung.

## Sprint 23

| Auftrag | Zustand | Details |
| --- | --- | --- |
| API-Tests für Aufträge, Sprints und Bugs (b8004e48) | Entwickler fertig, Tester und Review stehen aus | Letzter Auftrag des Sprints, damit die neuen Regeln mit abgedeckt sind. Entwicklerlauf: 1526/1526 Tests grün, 0 übersprungen. |

Die anderen Aufträge des Sprints stehen in ihren eigenen Dokumenten (z. B. `aus-dem-sprint-nehmen-nur-geplant-oder-blockiert-2026-10-25.md`, `erneut-versuchen-nur-planbare-sprints-2026-10-25.md`, `sprint-loeschen-auftraege-in-freigabe-2026-10-25.md`). Der Test sichert deren Regeln gegen einen späteren Umbau.

## Anfrage / TODO

- **Offen, eigener Auftrag nötig:** Ein Bug im abgeschlossenen Sprint erzeugt beim Bearbeiten des Titels einen geplanten Auftrag, den der Worker nie aufnimmt (`syncBugOrder`).
- **Wartet auf Zweig 172c4f29:** `syncBugOrder` hängt beim Sprintwechsel eines Bugs einen laufenden Auftrag mit um. Nach dem Merge des Fixes den Test „laufender Bug-Auftrag bleibt im Sprint“ ergänzen.
- **Für den Tester:** Test nur über `npm test` starten, nicht mit `npx tsx --test` und nicht mit Abdeckungs-Flags (der Wächter blockiert beides).
- Rund 29 von 44 Routen-Dateien haben weiter keine Tests (u. a. `auth.ts`, `projects.ts`, `agents.ts`). Dieser Auftrag deckt nur Aufträge, Sprints und Bugs ab.

## Technik

- `withMigratedDatabase` legt eine frische, migrierte Datenbank an. Jeder Teiltest legt ein eigenes Projekt an, also keine gemeinsame Datenbank oder Reihenfolge.
- Geprüft wird der Datenbankstand, nicht nur der Statuscode. Bei 409 wird die komplette Zeile vor und nach dem Aufruf verglichen (auch `updated_at`, `git_sync`), damit keine Teilschreibvorgänge oder Git-Syncs unbemerkt bleiben.
- Der Bug-Status wird über die Datenbank-Trigger mitgeprüft (Retry, review-reject).
- Die Pool-Attrappen-Tests bleiben bestehen und prüfen weiter SQL-Text und Statuscodes.
