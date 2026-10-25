# Agent-Berichte pausieren den Sprint nicht mehr als „fremde Änderungen“ (25.10.2026)

Auftrag 97ad31e0 (Bugfix, Sprint 23). Commit `005be2b`.

## Problem
Tester und Test-Gate legen Berichte in `docs/tests/` ab, der Bug-Wächter in `docs/risiken/`. Die Dateien sind neu und unversioniert. Der Auftrags-Commit nahm nur `docs/tests/` aus, und auch der Sauberkeits-Check (`CHANGED_FILES_IGNORED`) kannte nur diesen Ordner. `docs/risiken/` stand in `git-helpers.ts` nicht drin, `report-copies.ts` führte eine zweite Liste. Ein Bug-Wächter-Bericht blieb nach dem Merge liegen, und der nächste Auftrag brach in `enterOrderBranch` mit „fremde, nicht committete Änderungen“ ab. Der Sprint pausierte (Sprint 23 am 25.10. zweimal).

## Änderung
- **`src/runner/git-sync/report-copies.ts`:** `REPORT_DIRECTORY` (ein Ordner) ist jetzt `REPORT_DIRECTORIES = ['docs/tests/', 'docs/risiken/']`. Das ist die einzige Liste der Berichtsordner. `dropReportCopies` räumt lose Kopien aus beiden Ordnern weg, wenn das Ziel sie unverändert enthält.
- **`src/runner/git-sync/git-helpers.ts`:** `CHANGED_FILES_IGNORED = ['.dev-log/', ...REPORT_DIRECTORIES]`. `REPORT_DIRECTORIES` wird zusätzlich re-exportiert. Die Liste gilt für den Auftrags-Commit (`stageAll` mit `orderOnly`) und für den Sauberkeits-Check. Die Kommentare nennen jetzt „Berichte“ statt „Testberichte“.
- **Doku:** `docs/workflows.md` (Abschnitt „Arbeitsordner nicht sauber“ und „Sprint-Sicherung wartet bei unterbrochenen Aufträgen“).

## Verhalten
- Berichte gehören nicht in den Auftrags-Commit. Sie bleiben unversioniert, zählen aber nicht als fremde Änderung. Die Sprint-Sicherung committet sie später.
- Dabei gilt der Secret-Holdback: Ein Bericht mit Zugangsdaten wird zurückgehalten.
- Die Präfixe enden auf `/`. `docs/risiken-x/`, `docs/tests-extra/`, `docs/andere.md` und `src/…` bleiben fremd und lösen weiter den Abbruch aus.

## Tests
Neu: `src/runner/git-sync/report-folders.test.ts` (echtes Git-Repo).
1. Ablauf: Tester-Bericht, Auftrag A gemergt, Bug-Wächter-Bericht dazu, Auftrag B startet ohne Fehler. Der Sprint-Branch enthält keinen Bericht.
2. Gegenprobe: Die Pfade `docs/andere.md`, `docs/risiken-x/a.md`, `docs/tests-extra/a.md` und `src/neu.ts` brechen weiter ab. Die Meldung nennt den fremden Pfad, nicht den Bericht.
3. Ein Bericht mit Token in `docs/risiken/` wird bei der Sprint-Sicherung zurückgehalten.
4. Eine lose Kopie eines Risikoberichts blockiert den Checkout nicht.

**Teststand (Projekttestlauf 4e9889b1):** `npm run typecheck` grün. `report-copies.test.ts` und `report-folders.test.ts` laufen grün, 9 von 9 Tests.

**Offen:** Die Tester-Abnahme scheiterte an DoD 1, weil der Tester den Befehl nicht freigegeben bekam. Das ist ein Freigabe-Problem, kein Fehler im Code. Noch nicht gelaufen sind `git-helpers-porcelain.test.ts`, `secret-holdback.test.ts` und `git-sync.test.ts`. Sie prüfen, ob `porcelainPath`, der Secret-Holdback und `enterOrderBranch`/`finishOrderBranch` nach der Änderung an der Ordnerliste weiter funktionieren. Befehl: `npx --no-install tsx --test src/runner/git-sync/git-helpers-porcelain.test.ts src/runner/git-sync/secret-holdback.test.ts src/runner/git-sync.test.ts` (ohne Abdeckungs-Flags, der Wächter sperrt sie). Ob der Ablauftest vor dem Fix scheitert, ist nicht durch einen Lauf belegt: Vor dem Fix bricht er schon beim Import ab, weil `REPORT_DIRECTORIES` fehlte.

## Hinweis
- Neue Berichtsordner nur in `REPORT_DIRECTORIES` eintragen, nicht in eine zweite Liste.
- Pfade aus `git status` nur mit `porcelainPath` auswerten (die erste Statuszeile verliert sonst das führende Leerzeichen).

## Sprint 23 und Anfrage/TODO
- Auftrag 97ad31e0: umgesetzt. Die Auftragstests sind grün, die drei bestehenden Git-Sync-Tests stehen aus.
- TODO: die drei Testdateien freigeben oder von Hand ausführen, danach Review.
- Benutzerhandbuch: Abschnitt 19 in `docs/benutzerhandbuch-dashboard-agents.md` beschreibt die Änderung für Anwender.
