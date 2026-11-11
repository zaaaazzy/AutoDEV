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
- `src/runner/runner-steps.ts`
  - Neue, exportierte Funktion `conflictSection(branch)`: liefert den Konfliktabschnitt für den Prompt, oder leer ohne Konflikte.
  - Neue, exportierte Funktion `remainingConflicts(cwd, execute)`: liefert die Dateien, die noch Marker enthalten. Scheitert die Prüfung selbst, zählt das als offener Konflikt, der Schritt besteht dann nicht. Vorher schluckte `.catch(() => [])` den Fehler.
  - `runStep` nutzt genau diese beiden Funktionen. Sie machen den Weg bis in Prompt und Schritt-Prüfung testbar.
- `src/runner/git-sync.test.ts`
  - Regressionstest mit echtem Auftrags-Branch, `MERGE_HEAD` und Markern. Der zweite Aufruf von `enterOrderBranch` simuliert den Neustart. Er prüft:
    - `conflicts` ist `['liste.txt']`, und `conflictSection` enthält den Konfliktabschnitt mit `liste.txt`.
    - `remainingConflicts` meldet `['liste.txt']`, solange die Marker stehen, und `[]` nach dem Lösen.
    - `MERGE_HEAD` und der Dateiinhalt sind unverändert, und `commitAgentStep` lehnt den Commit ab.
    - Nach dem Lösen und Committen liefert `enterOrderBranch` wieder `{ branch, base }`.
  - Fehlerfall: `unresolvedConflicts` wirft bei Exit-Code 128, `remainingConflicts` meldet die Konflikte dann als offen.
  - Gegentest: Fortsetzen ohne Merge, aber mit angefangener Änderung, liefert `{ branch, base }` ohne `conflicts` und mit leerem Konfliktabschnitt. Die Änderung bleibt erhalten.
- `docs/workflows.md`: Absatz „Fortsetzen mit offenem Merge-Konflikt“ beschreibt das Verhalten für Nutzer.

## Worauf zu achten ist

- **Neues Fehlerverhalten:** `unresolvedConflicts` wirft jetzt. Aufrufer müssen damit umgehen:
  - `runStep` fängt den Fehler und wertet ihn als offenen Konflikt.
  - `enterOrderBranch` im Fortsetzungszweig reicht den Fehler weiter. Der Auftrag scheitert also, statt ohne Prüfung weiterzulaufen.
  - Die Aufrufer in `finishOrderBranch` und `commitAgentStep` sollten bei Änderungen an diesem Bereich mitgeprüft werden.
- **Testabdeckung:** Prompt und Schritt-Prüfung sind über `conflictSection` und `remainingConflicts` getestet. Ein Test, der `runStep` selbst mit einem echten Agent durchläuft, fehlt weiterhin.
- **Parallele Änderungen:** `order-branch.ts` berühren auch die Aufträge 6 bis 8 des Sprints. Sie sollten nacheinander gemergt werden.
- **Testlauf:** `npm run typecheck` und `npx tsx --test src/runner/git-sync.test.ts src/runner/runner-steps.test.ts` sind grün (50 von 50 Tests). Die Abdeckung wurde nicht gemessen.
