# Autopilot startet den nächsten Sprint erst, wenn main den letzten enthält

Auftrag 75b989ac (Bugfix, Code-Review vom 21.10.2026, Stand `a4971e9`). Sprint 23.

## Ursache

Liegt `main` in einem anderen Ordner (Ordner der Menschen) und ist `restart_after_sprint` aus, protokollierte der Abschluss nur „dort mit git merge übernehmen“, setzte aber `git_sync = 'done'`. `autopilotGuard` meldete `ready`, und der nächste Sprint-Branch entstand vom alten `main`: rote Tests, doppelte Arbeit, Konflikte erst beim späteren Zusammenführen.

Die Fundstellen im Auftrag (`git-sync.ts`) waren veraltet; die Logik liegt in `src/runner/git-sync/sprint-sync.ts`.

## Umsetzung

- **Neuer Zustand `awaiting_merge`** („Wartet auf Merge“) in `sprints.git_sync`. Migration `sprint-wartet-auf-merge` in `src/db/migrations.ts` (mehrfach lauffähig) ersetzt den CHECK-Constraint um den neuen Wert.
- **Abschluss** (`syncSprintToGit`, `sprint-sync.ts`): `done` gibt es nur, wenn `main` den Sprint enthält. Meldet der Merge `awaitingMerge` (main in anderem Ordner mit offenen Änderungen) oder ist der Sprint-Branch laut `mainContains` nicht in `main`, wird `awaiting_merge` gesetzt. Dann gibt es kein Live schalten und keinen Neustart.
- **Prüfung** (`git-helpers.ts`, `mainContains`): `git merge-base --is-ancestor <sprint> main`. Exit 1 heißt „kein Vorfahre“, also warten. Jeder andere Fehler ist ein echter Fehler.
- **Auflösung** (`settleAwaitingMerge`): bei jedem Sync-Lauf wird geprüft, ob lokales oder GitHub-`main` (`freshestMain`) den vermerkten Stand enthält. Dann wird der Sprint `done`. Scheitert die Prüfung selbst, wird er `failed`, weder „fertig“ noch „wartet“. Das Update ist auf `git_sync = 'awaiting_merge'` begrenzt, also idempotent. Ein PATCH auf einen abgeschlossenen Sprint löst es nicht neu aus.
- **Autopilot** (`src/api/sprint-planning.ts`, `autopilotGuard`): Ist der letzte Sprint `awaiting_merge`, meldet er `finishing` mit Begründung („noch nicht in main – wartet auf den Merge“, plus Git-Meldung).
- **API** (`src/api/sprints.ts`): der Zustand wird mitgeliefert.
- **Oberfläche**: Badge „Wartet auf Merge“ in der Sprint-Liste und Hinweis im Sprint-Detail (`wait-status.ts`, `sprints.component.html`, `sprint-detail.component.html`).

## Worauf zu achten ist

- Der Merge muss von Hand im Ordner der Menschen erfolgen: `git merge <Sprint-Branch>`. Danach wird der Sprint beim nächsten Sync von selbst `done`, und der Autopilot startet den nächsten Sprint.
- Der Zustand entsteht nur für abgeschlossene Sprints (nicht bei `pull`).
- Tests nur über `npm test` bzw. `npm run …`, nicht mit `npx tsx --test` oder Abdeckungs-Flags (blockiert der Wächter).

## Tests

- `src/db/schema.test.ts`: CHECK-Constraint erlaubt `awaiting_merge`, Migration mehrfach lauffähig.
- `src/runner/git-sync.test.ts`: temporäre Repos, `main` im eigenen und im anderen Ordner, `restart_after_sprint` an und aus, später gemergt wird `done`.
- `src/runner/sprint-autopilot.test.ts` und `src/api/app.test.ts`: Guard liefert bei `awaiting_merge` nicht `ready`.
- `frontend/src/app/features/runs/wait-status.spec.ts`: Anzeige des Zustands.

## Geänderte Dateien

- `src/runner/git-sync/sprint-sync.ts`
- `src/runner/git-sync/git-helpers.ts`
- `src/api/sprint-planning.ts`
- `src/api/sprints.ts`
- `src/db/migrations.ts`
- `src/db/schema.test.ts`
- `src/runner/git-sync.test.ts`
- `src/runner/sprint-autopilot.test.ts`
- `src/api/app.test.ts`
- `frontend/src/app/features/runs/wait-status.ts`
- `frontend/src/app/features/runs/wait-status.spec.ts`
- `frontend/src/app/features/sprints/sprints.component.html`
- `frontend/src/app/features/sprints/sprint-detail.component.html`
- `docs/workflows.md`, `docs/laufzeit.md`
- `docs/autopilot-wartet-auf-merge-2026-10-25.md` (diese Datei)
