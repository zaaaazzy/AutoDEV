# Bug-Wächter: Risiken für Auftrag 97ad31e0 (Agent-Berichte pausieren den Sprint als „fremde Änderungen“)

Stand: `14d3067`, Sprint 23.

## Befund im Code

- `src/runner/git-sync/order-branch.ts:84-91` (`foreignChanges`) wertet `git status --porcelain --untracked-files=all` aus und lässt nur die Präfixe aus `CHANGED_FILES_IGNORED` durch.
- `src/runner/git-sync/git-helpers.ts:397`: `CHANGED_FILES_IGNORED = ['.dev-log/', 'docs/tests/']`. **`docs/risiken/` fehlt.** Die Berichte des Bug-Wächters sind deshalb „fremd“. Das ist die wahrscheinliche Hauptursache.
- `docs/tests/` ist schon ausgenommen. Trotzdem pausierte der Sprint wegen Tester-Berichten. Dafür kommen diese Ursachen in Frage, die du prüfen musst:
  - Der Bericht liegt außerhalb des Präfixes (z. B. `docs/tests/<Datum>/` vom Test-Gate ist abgedeckt, `docs/test/` oder ein anderer Name nicht).
  - Der Bericht ist als geänderte, versionierte Datei da (`M`) statt neu. Prüfe `trackedChanges` (`git-helpers.ts:438`).
  - Die Pfade kommen verstümmelt an (siehe Bug 1).
- `src/runner/git-sync/report-copies.ts` (`REPORT_DIRECTORY = 'docs/tests/'`, `dropReportCopies`) kennt ebenfalls nur `docs/tests/`. Das ist eine zweite Liste neben `CHANGED_FILES_IGNORED`.
- Kommentare sagen: Testberichte werden „später auf main committet“ bzw. von der Sprint-Sicherung mitgenommen. Prüfe, ob diese Sicherung nach dem Merge der Aufträge wirklich vor dem nächsten `enterOrderBranch` läuft. Sonst bleibt die Lücke.

## Relevante frühere Bugs: was nicht wiederholt werden darf

1. **Pfad-Parsing von `git status --porcelain`** (`porcelainPath`, `git-helpers.ts:426`, Test `git-helpers-porcelain.test.ts`)
   - `gitHelpers` trimmt die Ausgabe, die erste Zeile verliert ihr führendes Leerzeichen. Ein festes `slice(3)` schnitt den ersten Buchstaben ab (`ocs/tests/…`), und ignorierte Pfade galten als fremd.
   - Nicht wiederholen: eigene Pfad-Auswertung neben `porcelainPath`. Teste den Fall, dass der Bericht die **erste** Zeile der Ausgabe ist.
2. **Tester: Aufträge ohne Sprint im losgelösten Agent-Worktree landen in main** (behoben)
   - Nicht wiederholen: `main` im Agent-Ordner auschecken oder den Commit-Weg für Aufträge mit und ohne Sprint nur für einen Fall ändern. Teste beide Wege (mit Sprint, ohne Sprint, losgelöster Worktree).
3. **Secret-Holdback** (`src/runner/git-sync/secret-holdback.test.ts`, Tester-Bug „Aufträge hinzufügen“ listet ihn als fehlgeschlagen)
   - Die Commits filtern Dateien nach Geheimnissen. Berichte aus Agent-Läufen können Tokens oder `.env`-Inhalte zitieren.
   - Nicht wiederholen: neue Dateien am Holdback vorbei committen. Wenn Berichte in den Auftrags-Commit wandern, müssen sie durch dieselbe Prüfung laufen. Ein Test mit einem Bericht, der ein Geheimnis enthält, gehört dazu.
4. **Autofix: Code nicht geändert, nur der Test** (Endlosschleife)
   - Nicht wiederholen: nur den Test schreiben und den Code lassen. Der Test „Tester schreibt Bericht → Auftrag gemergt → nächster Auftrag startet“ muss **vor dem Fix scheitern** (Reviewer-Plan: erst der Test, dann der Fix).
5. **Tester: Abdeckung nicht messbar, Wächter blockiert `--experimental-test-coverage`; Freigabe für `npx tsx --test`**
   - Nicht wiederholen: Testbefehle, die der Agent-Wächter sperrt. Läufe nur mit `npx --no-install tsx --test <Dateien>`, ohne Abdeckungs-Flags. `sed`, `cat` und Ähnliches sind für Agents gesperrt, nimm die Datei-Werkzeuge.
6. **Auftrag blockiert ohne fehlgeschlagenen Schritt**
   - Das Pausieren zeigt die Ursache nur im Log. Die Meldung „fremde, nicht committete Änderungen“ soll bei Berichtspfaden gar nicht mehr erscheinen. Bleibt sie für echte Fremdänderungen, soll sie weiter die Pfade nennen.
7. **Bug „bugs_source_check“ / Migrationen**: kein Schema-Bezug hier, nur: keine Schemaänderung nötig. Wenn doch, über `src/db/migrations.ts` und mehrfach ausführbar.

## Empfehlungen

- **Eine Quelle für Berichtsordner.** Lege eine gemeinsame Liste an (z. B. `REPORT_DIRECTORIES = ['docs/tests/', 'docs/risiken/']`) und nutze sie in `CHANGED_FILES_IGNORED`, `report-copies.ts` und beim Mitnehmen im Commit. Keine dritte Kopie.
- **Berichte gehören zum Commit, nicht nur in die Ausnahme.** Ignorieren allein lässt sie unversioniert liegen. Das Risiko ist `dropReportCopies` oder Checkouts, die unversionierte Dateien überschreiben („würden überschrieben“). Entscheide bewusst: entweder im Auftrags-Commit mitnehmen (durch den Holdback) oder in der Sprint-Sicherung. Beschreibe die Wahl im Kommentar.
- **Fremde Dateien bleiben fremd.** Die Ausnahme gilt nur für die Berichtsordner. Ein `docs/andere.md` muss weiter den Abbruch auslösen (Gegenprobe im Test). Prüfe auch Pfade wie `docs/tests-extra/` bzw. `docs/risiken-x`: Der Präfix-Vergleich mit Schrägstrich am Ende verhindert falsche Treffer.
- **Test des ganzen Ablaufs** (echtes temporäres Git-Repo, wie in `git-sync.test.ts`): Tester schreibt `docs/tests/…`, Bug-Wächter schreibt `docs/risiken/…` → Auftrag A wird gemergt → `enterOrderBranch` für Auftrag B wirft nicht. Zusätzlich: Bericht liegt als erste Statuszeile; Test-Gate-Ordner `docs/tests/<Datum>/`; fremde Datei außerhalb → weiter OrderBranchError.
- Doku: Passende Datei unter `docs/` anpassen (Wo landen Agent-Berichte?).

@@NACHRICHT an Entwickler: Bericht liegt in docs/risiken/2026-10-25_auftrag-97ad31e0-bug-waechter.md. Kern: `CHANGED_FILES_IGNORED` (git-helpers.ts:397) enthält nur `docs/tests/`, `docs/risiken/` fehlt; `report-copies.ts` hat eine zweite Liste. Eine gemeinsame Liste nutzen. Pfade nur über `porcelainPath` auswerten (erste Statuszeile verliert das Leerzeichen). Berichte nicht am Secret-Holdback vorbei committen. Fremde Dateien müssen weiter abbrechen (Gegenprobe). Test zuerst schreiben, er muss vor dem Fix scheitern. Tests nur mit `npx --no-install tsx --test <Dateien>`, ohne Abdeckungs-Flags.
