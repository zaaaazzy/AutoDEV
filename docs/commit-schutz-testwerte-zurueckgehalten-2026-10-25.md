# Commit-Schutz: Testwerte und zurückgehaltene Dateien (2026-10-25)

## Problem
Die Git-Sicherung hielt Testdateien mit erfundenen Tokens zurück (z. B. `sk-ant-api03-AbCdEf…`). Sie blieben uncommittet
im Arbeitsordner, wanderten beim Checkout auf den Sprint-Branch mit, und der nächste Auftrag pausierte den Sprint
(„fremde, nicht committete Änderungen“). Der Auftrag selbst galt als erledigt, obwohl seine Tests fehlten.

## Verhalten jetzt
- **Testwerte in Testdateien** (`*.test.ts`, `*.spec.ts`, auch `.js`/`.tsx`): Eine Fundstelle zählt nicht als
  Zugangsdaten, wenn sie
  - einem bekannten Platzhaltermuster folgt: Wörter wie `EXAMPLE`, `FAKE`, `DUMMY`, `PLACEHOLDER`, `BEISPIEL`, lange
    Wiederholungen (`xxxxxxxx`) oder Folgen wie `abcdef`/`AbCdEf`/`123456`. Ein PEM-Block zählt als Platzhalter, wenn
    er in derselben Zeile kurz endet.
  - oder markiert ist: Kommentar `dev-log: testwert` in derselben oder der Zeile direkt davor.

  Geprüft wird jede Fundstelle einzeln: Steht neben einem Platzhalter ein echter Schlüssel, bleibt die Datei
  zurückgehalten. In anderen Dateien gilt keine Ausnahme.
- **Zurückgehaltene Dateien am Auftragsende** (`finishOrderBranch`): Die Dateien werden nach
  `.dev-log-backups/zurueckgehalten-<auftrag>-<zeit>/` kopiert und aus dem Arbeitsordner genommen. Versionierte Dateien
  gehen auf HEAD zurück, neue werden gelöscht. Der übrige Stand wird auf dem Auftrags-Branch committet, aber **nicht
  gemergt**. Der Auftrag wird „blockiert“. Die Meldung mit den Dateinamen und dem Sicherungsordner steht unter
  `failure`, die Aktion lautet „Dateien wegen Zugangsdaten zurückgehalten – Testwerte markieren bzw. Schlüssel
  entfernen, dann „Erneut versuchen““. Der nächste Auftrag startet ohne fremde Änderungen.

## Hinweis für Tests
Echt aussehende Tokens im Testcode weiter zusammensetzen (`'ghp_' + '…'`) oder mit `dev-log: testwert` markieren.

## Geänderte Stellen
- `src/runner/git-sync/git-helpers.ts`: `filesWithSecrets` mit Testwert-Ausnahme, `isPlaceholderToken`,
  `setAsideFiles`.
- `src/runner/git-sync/order-branch.ts`: `finishOrderBranch` liefert `secrets`, mergt dann nicht und räumt den Ordner
  auf. `rescueOrderBranch` räumt ebenfalls auf.
- `src/runner/runner-settle.ts`, `src/runner/action-todo.ts`: neue Aktion `SECRETS_TODO`.
- Tests: `src/runner/git-sync/secret-holdback.test.ts`.
