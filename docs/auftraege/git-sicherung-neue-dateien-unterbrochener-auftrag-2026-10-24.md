# Git-Sicherung pusht keine neuen Dateien eines unterbrochenen Auftrags mehr

Auftrag 4565a6e1 (Bugfix, Bereich runner, Schwere mittel). Stand: 24.10.2026.

## Problem

`orderWorkInProgress` prüfte mit `--untracked-files=no`. Hatte ein unterbrochener Auftrag nur neue Dateien angelegt, galt der Ordner als „nicht in Arbeit“. Die Sprint-Sicherung lief trotzdem: `pushSprint` checkte den Sprint-Branch aus (die unversionierten Dateien wanderten mit), `stageAll` nahm sie auf und committete sie als „Sprint-Stand sichern“, danach wurde gepusht. Halbfertige Dateien landeten so ungeprüft im Sprint-Branch und auf GitHub.

## Umsetzung

- `src/runner/git-sync/order-branch.ts`
  - `orderWorkInProgress` nutzt jetzt `foreignChanges`. Diese Funktion liest `git status --porcelain --untracked-files=all` und zählt damit auch neue, unversionierte Dateien.
  - Pfade aus `CHANGED_FILES_IGNORED` (Testberichte, Agent-Ablage) zählen nicht mit. Der Ordner gilt deshalb nicht dauerhaft als „in Arbeit“.
  - Steht HEAD nicht auf einem `auftrag/`-Branch, bleibt das Ergebnis `false`.
- `src/runner/git-sync.test.ts`
  - Test „Git-Sicherung wartet auch, wenn der unterbrochene Auftrag nur neue Dateien angelegt hat“: `orderWorkInProgress` liefert `true`, `syncSprintToGit` liefert 0, der Sprint wird nicht auf `running` gesetzt, es gibt keinen Checkout und keinen Commit, die Datei bleibt unversioniert.
  - Gegenfall „Testberichte und Agent-Ablage allein halten die Git-Sicherung nicht auf“.

## Worauf zu achten ist

- **Gewählte Lesart:** Es zählt die Dateiprüfung, nicht ein pauschaler Stopp auf jedem `auftrag/`-Branch. Ein sauberer Auftrags-Branch ohne Änderungen blockiert die Sicherung also nicht. Wer die strengere Lesart will, setzt in `orderWorkInProgress` nach der Branch-Prüfung `return true`.
- **Gemeinsame Funktion:** `foreignChanges` prüft auch beim Betreten eines Auftrags-Branchs auf fremde Änderungen (`enterOrderBranch`). Änderungen an `CHANGED_FILES_IGNORED` wirken auf beide Stellen und auf `changedFiles`.
- **Fehler bei `git status`:** Schlägt der Befehl fehl, liefert `foreignChanges` eine leere Liste, `orderWorkInProgress` also `false`. Das ist fail-open und wurde nicht geändert.
- **Zeilen aus dem Bugbericht:** Die Angaben (`git-sync.ts:1008-1023`, `1042-1045`) wurden nicht einzeln zugeordnet. Der Code liegt inzwischen unter `git-sync/`.
- **Testlauf:** `npm run typecheck` und `src/runner/git-sync.test.ts` sind grün (35 von 35). Der vollständige `npm test` lief beim Entwickler vor der Änderung mit 1234/1234 und danach mit 1236/1236 grün. Die Abdeckung wurde nicht gemessen.
- **`secret-holdback.test.ts`:** Die Datei war vor und nach der Änderung grün (2 von 2). Der als offen gemeldete Fehler (3 von 3 rot) war hier nicht nachzustellen. Die Änderung hat ihn weder ausgelöst noch behoben.
