# Freigabe-Merge auch im eigenen Agent-Worktree und mit Ordnersperre

Auftrag f5291510 (Bugfix, Code-Review vom 21.10.2026, Stand `a4971e9`). Sprint 23.

## Ursache

Nach der Freigabe merged `processApprovals` (`src/runner/review-gate.ts`) den Auftrags-Branch über `mergeApprovedBranch`. Bei Review-Modus `ui` oder `always` betraf das jeden Bugfix ohne Sprint, die Basis ist dann `main`. Hat das Projekt einen eigenen Agent-Worktree, ist `main` im Ordner der Menschen ausgecheckt, und ein `checkout main` scheitert. Der Auftrag blieb als „Freigabe nicht gemergt“ blockiert.

Zwei Dinge fehlten zusätzlich: `processApprovals` nahm keine Ordnersperre (ein paralleler Chat konnte zwischen Statusprüfung und Merge Dateien ändern), und die Vorschau wurde nach dem Merge nicht nachgezogen.

## Umsetzung

- **Checkout-Teil war schon behoben.** `mergeApprovedBranch` (`src/runner/git-sync/order-branch.ts`) nutzt wie `finishOrderBranch` `checkedOutElsewhere` und `mergeIntoOtherWorktree`. Dort wurde nichts mehr geändert.
- **Ordnersperre:** `processApprovals` nimmt `acquireTree(cwd)` und gibt sie in `finally` wieder frei. Ohne freigegebene Aufträge wird keine Sperre genommen. Die eigentliche Schleife steht jetzt in `mergeApprovals`.
- **Vorschau nachziehen:** Nach jedem erfolgreichen Merge ruft `mergeApprovals` `followProjectPreview(pool, project, cwd, item.base, execute)` auf, wie `go-live.ts`. Die Funktion fängt Fehler selbst ab und schreibt sie ins Log. Scheitert das Nachziehen, bleibt der Merge gültig.

## Tests

Neue Datei `src/runner/review-gate-worktree.test.ts` mit echten Git-Worktrees und nachgebauter Datenbank-Verbindung:

- **Freigabe ohne Sprint:** `main` ist im Ordner der Menschen ausgecheckt, die Agents arbeiten in einem losgelösten Worktree. Ein Chat hält die Ordnersperre; `processApprovals` wartet nachweislich bis zur Freigabe. Danach ist der Auftrag erledigt, der Commit steckt in `main`, die Datei liegt im Ordner der Menschen, der Branch ist gelöscht.
- **Vorschau:** Basis ist `sprint/s1`. Nach der Freigabe steht der Projektordner auf dem neuen Sprint-Stand.

Ausführen nur mit `npm test`. `npx tsx`, `node --import tsx` und `--experimental-test-coverage` blockiert der Wächter. Der Entwickler hat den Test nicht gegen den alten Code laufen lassen.

## Geänderte Dateien

- `src/runner/review-gate.ts`
- `src/runner/review-gate-worktree.test.ts`
- `docs/freigabe-merge-agent-worktree-ordnersperre-2026-10-25.md` (diese Datei)

## Worauf zu achten ist

- Nicht `checkout <base>` aufrufen, wenn die Basis in einem anderen Worktree steht.
- Den Ordner nicht ohne `acquireTree` ändern; die Sperre nicht verschachtelt nehmen (`mergeApprovals` nimmt selbst keine).
- Erfolg nur melden, wenn der Branch nachweislich in der Basis steckt (`merge-base --is-ancestor` in `mergeIntoOtherWorktree`).

## Sprint und Anfrage/TODO

- Zustand des Auftrags: umgesetzt, Test geschrieben, wartet auf Tester/Review.
- Offen: Der Test wurde noch nicht gegen den alten Code geprüft (ohne Sperre müsste „wartet auf die Ordnersperre“ scheitern, ohne Nachziehen die Vorschau-Prüfung).
