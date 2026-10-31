# Unterbrochener Auftrag verlässt seinen Auftrags-Branch

Auftrag b5591912 (Bugfix, Bereich runner). Stand: 25.10.2026.

## Problem

Bei Sprint-Pause, Worker-Stopp oder Laufwerksausfall wurde der Auftrag auf `planned` zurückgesetzt, der Arbeitsordner blieb aber auf dem Branch `auftrag/…`, teils mit offenen Änderungen. Nahm der Worker danach einen Auftrag ohne Sprint (z. B. einen Bugfix mit `auto_run`), warf `enterOrderBranch` einen `OrderBranchError` wegen des fremden Branchs. Der Auftrag endete blockiert mit „Arbeitsordner aufräumen (Git)“, obwohl nichts kaputt war.

## Umsetzung

- `src/runner/git-sync/order-branch.ts`
  - `leavesForMain` zählt jetzt auch `auftrag/…` zu den Branches, die ein Auftrag ohne Sprint verlässt. Er zweigt dann von `main` ab.
  - Der Fall „fremde Änderungen“ wird vorher geprüft und wirft weiter `OrderBranchError`. Verlassen wird also nur ein sauberer fremder Auftrags-Branch (seine Arbeit steckt in Commits).
- `src/runner/runner-settle.ts`
  - `settleItem` sichert bei `interrupted` den Stand wie bisher als WIP-Commit (`commitTaskToGit`, mit Secret-Holdback) und gibt den Ordner frei.
  - Steht der Ordner danach noch mit offenen Änderungen auf einem Auftrags-Branch (`orderWorkInProgress`), legt `recordCleanupFailure` einen gescheiterten Schritt „Arbeitsordner aufräumen (Git)“ mit Meldung an und setzt `failure` am Auftrag. Der Schritt ist als `interrupted` markiert, damit der nächste Lauf beim unterbrochenen Agent fortsetzt.
- `docs/workflows.md`: Absatz zum eigenen Agent-Worktree ergänzt.

## Tests

- `src/runner/interrupted-order.test.ts` (neu): Unterbrechung mit Änderungen, harter Abbruch nach dem Schrittcommit mit anschließendem Auftrag ohne Sprint (kein `OrderBranchError`), Commit scheitert beim Aufräumen (gescheiterter Schritt mit Meldung).
- `src/runner/git-sync-safety.test.ts`: Der Test „nie vom Branch eines anderen Auftrags abzweigen“ ist aufgeteilt: sauberer fremder Branch wird verlassen; einer mit Änderungen bleibt bei `OrderBranchError`, die Änderungen bleiben erhalten.

## Worauf zu achten ist

- **Kein leerer Commit:** Bei sauberem Worktree entsteht kein WIP-Commit und kein Fehler.
- **Fremde Änderungen bleiben geschützt:** Ein fremder `auftrag/`-Branch mit offenen Änderungen wird nie verlassen.
- **Nicht nachgewiesen:** Dass die neuen Tests vor dem Fix rot waren, wurde nicht ausgeführt, sondern aus dem Code geschlossen.
- **Testlauf:** Einzelne Testdateien ließen sich wegen des Befehlswächters nicht starten. `npm test` lief beim Entwickler mit 1530 von 1530 grün. Die Abdeckung wurde nicht gemessen.
- **Anders als im Vorschlag:** `leaveOrderBranch` wird nicht beim Unterbrechen aufgerufen. Der Branch wird beim Start des nächsten Auftrags verlassen (`enterOrderBranch`); beim Unterbrechen gibt es nur den WIP-Commit und bei Misserfolg den sichtbaren Schritt.
