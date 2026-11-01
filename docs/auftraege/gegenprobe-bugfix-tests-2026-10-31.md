# Gegenprobe: neue Tests gegen den Stand vor dem Fix (31.10.2026)

Auftrag 37938d19 („Gegenprobe: neue Tests gegen den Stand vor dem Fix“), aus Sprint 29 zurückgestellt und im
Arbeitscontainer neu geprüft.

## Ablauf

- Nach dem grünen Test-Gate, nach Push und Merge (`src/runner/git-sync/sprint-sync.ts`), ruft der Sprint-Abschluss
  `runSprintCounterChecks` (`src/runner/git-sync/counter-check.ts`) auf. Die Gegenprobe ist rein informativ und kann
  Push und Merge weder verhindern noch zurücknehmen.
- Geprüft werden nur erledigte Aufträge mit `kind = 'bug'`, mindestens einer geänderten Testdatei in `changed_files`
  und noch ohne Ergebnis (`counter_check IS NULL`).
- Auftrags-Commit ist `git_commit`, Basis-Commit dessen erster Elternteil. Im Temp-Ordner (`aideation-gegenprobe-*`)
  entsteht ein losgelöster Worktree auf dem Basis-Commit; nur die Testdateien kommen aus dem Auftrags-Commit.
  Hauptordner, Sprint-Branch, Index und `HEAD` bleiben unberührt. Der Worktree wird im `finally` entfernt; verwaiste
  Worktrees früherer Läufe räumt `pruneCounterCheckWorktrees` vor jedem Lauf ab (`git worktree prune`).
- Es laufen nur die Testbefehle je Auftrag mit `{tests}`, einzeln je Datei, über denselben `testExecutor` wie das
  Gate (Sandbox bzw. gefiltertes Environment). Ohne Sandbox werden nur `node_modules` verlinkt, keine `.env`.
- Zeitgrenzen: 5 Minuten je Befehl, 10 Minuten je Sicherung.

## Ergebnisse je Testdatei

| Wert      | Text                       |
| --------- | -------------------------- |
| `fails`   | scheitert ohne Fix         |
| `passes`  | läuft auch ohne Fix grün   |
| `import`  | bricht beim Import ab      |
| `skipped` | nicht bewertet (Playwright) |
| `error`   | Gegenprobe gescheitert     |

„Bricht beim Import ab“ gilt nur für Ladefehler vor dem ersten Testfall (`classifyTestFileRun` in
`src/runner/git-sync/ci.ts`); ein Modul- oder ENOENT-Fehler innerhalb eines Testfalls bleibt „scheitert ohne Fix“.
Fehler der Gegenprobe selbst (kein Commit, kein Befehl, Zeitüberschreitung) stehen sichtbar im Testbericht und am
Auftrag, sind aber weder „grün“ noch ein Blocker.

## Speicherung und Anzeige

- Neue Spalte `development_items.counter_check JSONB` über Migration 28 (`gegenprobe-je-auftrag`); `NULL` heißt
  „keine Gegenprobe“. Das Basis-Schema bleibt eingefroren. Ursprünglich als Version 19 geplant; 19–27 belegte
  inzwischen Sprint 30.
- Testbericht (`test_runs.report`, Auslöser `counter-check`): eine Zeile je geprüfter Testdatei.
- API: `counterCheck` in `DEV_COLUMNS` (`src/db/development-repository.ts`).
- Auftragsdetail: Abschnitt „Gegenprobe ohne Fix“ nur bei gesetztem Feld, bei „läuft auch ohne Fix grün“ mit Hinweis,
  dass der Test den Fix nicht beweist. Ohne Ergebnis erscheint kein Hinweis.
- Dokumentierer-Prompt bei Bugfixes (`COUNTER_CHECK_NOTE`): Gegenprobe nicht als offen vermerken und nicht als
  `@@NACHWEIS` mit `gegenprobe_fehlt` melden.

## Merge mit Sprint 30

- `DEV_COLUMNS` liegt jetzt im Repository; `counter_check` dort ergänzt.
- Migrationen: Gegenprobe auf Version 28 verschoben, Erwartungen der Migrationstests auf `[…, 27, 28]` angepasst.
- Prompt: `COUNTER_CHECK_NOTE` und `EVIDENCE_ROLES` beide übernommen.

## Prüfung

`npm run lint`, `npm run format:check`, `npm run typecheck` grün. `npm run test:unit`: alle Gegenprobe- und
Migrationstests grün (echte Git-Repos mit `node --test` und `tsx --test`). Ein Fehlschlag in
`src/core/git-guard.test.ts` („Filter aus .git/config …“) kommt aus der Umgebung: `/workspace/.git` verweist im
Container auf kein gültiges Repository.
