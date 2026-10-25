# Live schalten im PR-Modus für beide Worktree-Layouts

Auftrag 56c36360 (Bugfix, Code-Review vom 21.10.2026, Stand `a4971e9`). Sprint 23.

## Ursache

Im PR-Modus (`issues+pr`) merged GitHub den Pull Request, danach zieht `tagMergedSprint` (`src/runner/git-sync/sprint-reviews.ts`) das lokale `main` nach. Nur bei `mainUpdated = true` ruft `pollSprintReviews` `goLive` auf (Deploy und `production_deploys`-Eintrag).

- **Mit eigenem Agent-Worktree:** `main` ist im Projektordner (Live-Ordner) ausgecheckt, nicht im Agent-Ordner. Dieser Teil war durch den Fix zum früheren Bug „PR gemergt: main im Live-Ordner wird nach…“ schon korrekt. Die Tests sichern ihn jetzt ab.
- **Ohne eigenen Agent-Ordner:** `fetch origin main:main` aktualisiert nur die Referenz. Der Projektordner blieb auf `sprint/…`, und `deployProject` deployte den Sprint-Branch statt `main`. Dieses Layout war vor dem Fix rot.

Die Fundstellen im Auftrag (`git-sync.ts:1480-1497`) waren veraltet; die Logik liegt in `src/runner/git-sync/sprint-reviews.ts` und `go-live.ts`.

## Umsetzung

In `src/runner/git-sync/sprint-reviews.ts`:

- `tagMergedSprint` bekommt den Parameter `liveFolder` (Standard `cwd`) und das optionale `sprint.branch`. `pollSprintReviews` liest `projects.repository` und übergibt es.
- Ist `cwd` derselbe Ordner wie der Live-Ordner (verglichen per `realpath`, `sameFolder`) und steht nicht auf `main`, ruft sie `switchLiveFolderToMain` auf. Diese Funktion wechselt per `git checkout main`, aber nur wenn:
  - der Ordner auf dem Branch genau dieses Sprints steht (`sprintBranchOf`), und
  - keine offenen Änderungen an versionierten Dateien vorliegen (`status --porcelain --untracked-files=no`).
- Sonst bleibt der Ordner unberührt, `mainUpdated` wird `false`, es wird nicht deployt und der Sprint-Log nennt den Grund (fremder Branch bzw. offene Änderungen). Nie mit Gewalt.
- `pollSprintReviews` liest zusätzlich die Spalte `branch` des Sprints.

## Tests

- `src/runner/git-sync.test.ts`: `tagMergedSprint` mit echten Git-Ordnern.
  - Ohne eigenen Agent-Ordner: Wechsel auf `main`; Gegenproben „offene Änderung“ und „fremder Branch“ (kein Wechsel, Änderung bleibt erhalten).
  - Mit eigenem Agent-Ordner: Live-Ordner auf `main`, Live-Ordner als losgelöste Vorschau, Gegenproben „Ordner unsauber“ und „Ordner auf fremdem Branch“.
- `src/runner/github-sync.test.ts`: `syncGitHub` für beide Layouts. `main` im Live-Ordner entspricht dem Stand auf GitHub, und es gibt genau einen `production_deploys`-Eintrag.
- Ergebnis laut Entwickler: `npm test` ohne Abdeckungs-Flags, 1562 bestanden, 0 fehlgeschlagen.

## Geänderte Dateien

- `src/runner/git-sync/sprint-reviews.ts`
- `src/runner/git-sync.test.ts`
- `src/runner/github-sync.test.ts`
- `docs/workflows.md` (GitHub-Brücke, PR-Modus: Live schalten in beiden Layouts mit Bedingungen)
- `docs/logik-audit-behebung-2026-10-20.md` (Nachtrag: die Aussage vom 20.10. galt nur teilweise)
- `docs/live-schalten-pr-modus-beide-layouts-2026-10-25.md` (diese Datei)

## Worauf zu achten ist

- `liveFolderProblem` bleibt als Sicherung bestehen und wird nicht abgeschwächt.
- Kein `production_deploys`-Eintrag ohne echten Deploy; `goLive` läuft nur bei `mainUpdated = true`.
- Der Wechsel nur vom Branch dieses Sprints und nur bei sauberem Ordner, nie `--force`.
- Ein Ordner mit offenen Änderungen oder fremdem Branch wird nicht deployt. Der Hinweis steht im Sprint-Log, der Mensch muss dort selbst `git switch main` ausführen.
- Neue Layouts oder Aufrufer von `tagMergedSprint` müssen `liveFolder` übergeben, sonst gilt `cwd` als Live-Ordner.

## Sprint und Anfrage/TODO

- Zustand des Auftrags: umgesetzt, getestet (Suite grün), wartet auf Review/Freigabe.
- Keine offenen Punkte.
