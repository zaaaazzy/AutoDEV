# Git-Verlauf und Sprint-Review: Fehlerzustand und weniger Polling

Auftrag c30ff9d9 (Bugfix) aus dem Code-Review vom 21.10.2026 (Stand `a4971e9`). Stand: 29.10.2026. Der Auftrag betrifft nur das Frontend. Er ergänzt den Auftrag 838b0cb4 „Frontend: Listener-Leck, Polling in verborgenen Tabs, CSS, Fokus“ (`docs/frontend-listener-polling-css-fokus-2026-10-21.md`).

## Was umgesetzt wurde

### 1. Git-Verlauf behält bei Ladefehlern den letzten Stand
- Neu in `features/dashboard/git-graph.ts`: `GitGraphState` (`graph`, `loaded`, `error`) und `nextGitGraphState(state, result)`.
  - Erfolg: neuer Graph, `loaded = true`, `error = false`.
  - Fehler (`result === null`): Graph und `loaded` bleiben, nur `error = true`.
- `git-graph.store.ts` hält den Zustand in einem Signal und bietet `graph`, `loaded` und `error` als `computed` an. Leer wird der Zustand nur beim Projektwechsel.
- Ist der Tab beim Start verborgen, lädt der Store nicht sofort. `visibleInterval` lädt nach, sobald der Tab sichtbar wird. Der Minutentakt lief schon über `visibleInterval`.
- `git-graph-panel`: Bei `error()` steht oben ein Hinweis (`notice error`) „Git-Verlauf gerade nicht erreichbar“. Gibt es einen alten Stand, folgt „– angezeigt wird der letzte Stand“. Ohne Graph meldet das Panel bei einem Fehler nicht mehr „Noch kein Git-Verlauf“.
- Die Rand-Dekoration (`git-graph-backdrop.component.ts`) ist unverändert. Sie setzt ihre „neu“-Markierung nur zurück, wenn `graph` leer ist, und das passiert jetzt nur noch beim Projektwechsel. Bei einem Worker-Neustart flackert sie deshalb nicht mehr weg.

### 2. Sprint-Review nur bei offenen Sprints
- Neu in `features/sprints/review-launch.ts`: `sprintReviewable(status)`. Die Funktion liefert `true` bei `planned`, `active` und `review`.
- `sprint-detail.component.html` bindet `<app-sprint-review>` nur noch ein, wenn ein Review-Befehl gesetzt ist **und** `sprintReviewable(sprint.status)` gilt. Abgeschlossene und abgebrochene Sprints fragen nichts mehr ab.

### 3. Ein gemeinsamer Poll für die Review-Container
- Neuer Helfer `core/shared-poll.ts`: `sharedPoll(tick, ms)`. Er zählt die Abnehmer mit (wie `ReviewStateService`).
  - Die erste Anmeldung lädt sofort (nicht bei verborgenem Tab) und startet einen Takt über `visibleInterval`.
  - Jede weitere Anmeldung hängt sich nur an.
  - Meldet sich der letzte Abnehmer ab, endet der Takt.
  - Doppeltes Abmelden zählt nur einmal.
- `ReviewLaunchService.watchSlots()` meldet sich am gemeinsamen Poll von `/api/review-slots` an (alle 5 s). Zurück kommt die Abmeldefunktion.
- `SprintReviewComponent` ruft `loadSlots()` nicht mehr selbst auf. Sie meldet sich im Konstruktor über `watchSlots()` an und über `DestroyRef` wieder ab. Pro Instanz läuft nur noch der Abruf der eigenen Stände (`/api/sprints/:id/commits`), und auch der nur bei sichtbarem Tab.
- Die Kopfzeile (`header-review.component.ts`) ist unverändert. Sie hat eine eigene Instanz mit eigenem Takt (15 s, beim Start 3 s).

## Tests
- `core/shared-poll.spec.ts` (neu): Drei Abnehmer teilen sich einen Takt, und es gibt einen Abruf je Takt. Der letzte Abnehmer beendet den Takt. Danach startet eine neue Anmeldung den Takt neu. Bei verborgenem Tab gibt es keinen Sofortabruf.
- `features/dashboard/git-graph-state.spec.ts` (neu): Bei einem Fehler bleibt der alte Stand. Ein Fehler vor der ersten Antwort ist nicht „leer“. „Kein Verlauf“ vom Server ist kein Fehler.
- `features/sprints/review-launch.spec.ts`: Test für `sprintReviewable`.

## Prüfung
- `npm run typecheck` grün.
- `npm run test:unit`: 1804 Tests, alle grün.
- `npm run build:ui` baut. Die Warnungen (Budget `initial`, Optional-Chaining in `header-review`) gab es schon vorher.
- Ein E2E-Lauf und ein Test im Browser haben nicht stattgefunden.

## Worauf zu achten ist
- Weitere Anzeigen der Review-Container sollten `launch.watchSlots()` nutzen und nicht selbst `loadSlots()` im Takt aufrufen.
- `ReviewStateService` hat seine Zählung noch selbst. Er könnte später auf `sharedPoll` umgestellt werden.
