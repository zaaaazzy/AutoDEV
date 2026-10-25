# Bugs: Sprintzuordnung prüfen, laufende Aufträge nicht umhängen

Auftrag 172c4f29 (Bugfix, 25.10.2026). Sprint 23. Gefunden im Code-Review vom 21.10.2026 (Stand `a4971e9`).

## Ursache

- `syncBugOrder` (`src/api/bugs.ts`) setzte im `ON CONFLICT … DO UPDATE` die `sprint_id` des Bug-Auftrags in jedem Status. Ein Auftrag in `in_progress` oder `approval` wechselte so mitten im Lauf Sprint und Ziel-Branch.
- `PATCH /bugs/:id` prüfte nur Projekt und Sprint-Status, nicht den Status des Auftrags. Prüfung, Update und `syncBugOrder` liefen in getrennten Anweisungen ohne Transaktion.
- Die Prüfung auf abgeschlossene Sprints gab es bei POST und PATCH schon (`isAssignableSprintStatus`, 409).

## Umsetzung

- **Upsert:** Im `ON CONFLICT` folgt `sprint_id` dem Bug nur bei `backlog`, `planned`, `blocked` und `done`. `done` wird beim Wiederöffnen gleichzeitig `planned` und braucht deshalb den neuen Sprint. `auto_run`-Behebungsaufträge behalten ihren Sprint. In allen anderen Fällen bleibt der Wert erhalten.
- **Transaktion:** `syncBugOrder(db, bugId)` nimmt einen Pool (eigene Transaktion) oder einen Client (Transaktion des Aufrufers). Der neue Helfer `withBugTransaction` macht nur bei Status 200 ein `COMMIT`, sonst ein `ROLLBACK`.
- **PATCH:** Der Bug wird mit `FOR UPDATE` gesperrt. Ändert sich der Sprint (auch auf `null`), gelten zwei Prüfungen:
  - Ziel-Sprint im selben Projekt, sonst 400. Der Sprint muss geplant oder aktiv sein, sonst 409.
  - Kein Auftrag zum Bug in `in_progress` oder `approval`, sonst 409.
  - Danach laufen Update und `syncBugOrder` in derselben Transaktion. Derselbe Sprint wie bisher zählt nicht als Änderung.
- **POST:** Bug anlegen und `syncBugOrder` laufen in einer Transaktion.

## Bewusst nicht umgesetzt

Einen gemeinsamen Helfer `assignSprint` für PATCH `/development`, Folgeauftrag, Retry und `applyProposal` habe ich nicht gebaut. Diese Stellen prüfen schon mit `isAssignableSprintStatus` und `isSprintLockedDevelopmentStatus` (Schwesterauftrag „Sprint-Auswahl“). Ein Umbau ginge über den Bugfix hinaus. Dafür sollte ein eigener Auftrag entstehen.

## Tests (`src/api/bugs.test.ts`)

- Abgeschlossener Sprint: POST und PATCH ergeben 409. Es wird kein Bug angelegt, Titel und Sprint bleiben unverändert, und es entsteht kein Auftrag.
- Laufender Auftrag (`in_progress`, `approval`):
  - Wechsel in einen anderen Sprint oder auf `null` ergibt 409, und nichts wird geschrieben.
  - Derselbe Sprint geht weiter durch.
  - Ein direkter `syncBugOrder` nach einer Sprintänderung in der DB hängt den Auftrag nicht um.
- Gegenprobe: Ein geplanter oder blockierter Auftrag folgt dem neuen Sprint.

## Geänderte Dateien

- `src/api/bugs.ts`: Upsert, Transaktion (`withBugTransaction`), PATCH-Prüfung, POST in Transaktion.
- `src/api/bugs.test.ts`: neue API-Tests.
- `docs/bugs-sprintzuordnung-laufende-auftraege-2026-10-25.md`: diese Datei.

## Worauf zu achten ist

- Neue Aufrufer von `syncBugOrder` können einen Client der eigenen Transaktion übergeben. Mit einem Pool läuft die Funktion in einer eigenen Transaktion.
- Ändert sich der Sprint eines Bugs, während ein Auftrag läuft oder in Freigabe ist, antwortet die API mit 409 und schreibt nichts.
- Offen: ein gemeinsamer Helfer `assignSprint` für alle Zuordnungsstellen (eigener Auftrag nötig).
- Die Tests waren im Entwickler-Schritt noch nicht gelaufen. Starten ohne Abdeckungs-Flag: `npx --no-install tsx --test src/api/bugs.test.ts`.
