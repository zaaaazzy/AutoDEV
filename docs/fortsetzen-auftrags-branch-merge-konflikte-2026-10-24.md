# Fortsetzen auf dem Auftrags-Branch behält offene Merge-Konflikte

Auftrag 34b8d4d8 (Bugfix, Bereich runner, Schwere mittel). Stand: 24.10.2026.

## Problem

Stand der Ordner beim Start eines Auftrags schon auf dem Auftrags-Branch (z. B. nach einem Worker-Neustart während des Entwicklers), gab `enterOrderBranch` nur `{ branch, base }` zurück. Ein offener Merge mit Konfliktmarkern ging dabei verloren:

- Der Entwickler bekam keinen Konflikt-Prompt.
- Die Prüfung auf ungelöste Marker entfiel, der Schritt galt trotz Markern als bestanden.
- Commits wurden verweigert, der Tester prüfte Code mit Markern, und `finishOrderBranch` brach den Merge mit `merge --abort` ab.

## Umsetzung

- `src/runner/git-sync/order-branch.ts`
  - Im Fortsetzungszweig von `enterOrderBranch` wird `unresolvedConflicts(cwd, execute)` aufgerufen. Das Ergebnis kommt als `conflicts` zurück, aber nur wenn es nicht leer ist. Ohne Konflikte bleibt das Ergebnis `{ branch, base }`.
  - Der Zweig ruft weder `merge --abort` noch `reset` oder `checkout` auf. `MERGE_HEAD` und die Konfliktdateien bleiben unverändert.
  - `unresolvedConflicts` wirft jetzt, wenn `git diff --diff-filter=U` mit einem Fehlercode endet. Vorher galt ein Fehler stillschweigend als „keine Konflikte“ (fail-open).
- `src/runner/runner-steps.ts` (`runStep`)
  - Scheitert die Prüfung auf ungelöste Konflikte selbst, zählt das als offener Konflikt. Der Schritt besteht dann nicht. Vorher schluckte `.catch(() => [])` den Fehler.
- `src/runner/git-sync.test.ts`
  - Neuer Regressionstest mit echtem Auftrags-Branch, `MERGE_HEAD` und Markern. Der zweite Aufruf von `enterOrderBranch` simuliert den Neustart. Er prüft:
    - `conflicts` ist `['liste.txt']`, und `conflictPrompt` enthält den Konfliktabschnitt.
    - `MERGE_HEAD` und der Dateiinhalt sind unverändert, und `commitAgentStep` lehnt den Commit ab.
    - Nach dem Lösen und Committen liefert `enterOrderBranch` wieder `{ branch, base }`.
  - Fehlerfall: `unresolvedConflicts` wirft bei Exit-Code 128.

## Worauf zu achten ist

- **Neues Fehlerverhalten:** `unresolvedConflicts` wirft jetzt. Aufrufer müssen damit umgehen:
  - `runStep` fängt den Fehler und wertet ihn als offenen Konflikt.
  - `enterOrderBranch` im Fortsetzungszweig reicht den Fehler weiter. Der Auftrag scheitert also, statt ohne Prüfung weiterzulaufen.
  - Die Aufrufer in `finishOrderBranch` und `commitAgentStep` sollten bei Änderungen an diesem Bereich mitgeprüft werden.
- **Testlücke:** Den Weg bis in den Prompt des ersten ändernden Agents in `runner-steps.ts` deckt kein eigener Test ab. Der Prompt hängt nur an `ctx.branch.conflicts`, und das prüft der Regressionstest über `conflictPrompt`.
- **Parallele Änderungen:** `order-branch.ts` berühren auch die Aufträge 6 bis 8 des Sprints. Sie sollten nacheinander gemergt werden.
- **Testlauf:** `npm run typecheck` und `npx tsx --test src/runner/git-sync.test.ts src/runner/runner-steps.test.ts` sind grün (49 von 49 Tests). Die Abdeckung wurde nicht gemessen.
