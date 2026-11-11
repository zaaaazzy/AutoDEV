# Git-Hooks des Projekts im Worker nie ausführen

Auftrag 3691a610 (Bugfix, Schwere hoch, 25.10.2026). Sprint 23. Gefunden im Code-Review vom 21.10.2026 (Stand `a4971e9`).

## Ursache

Der Worker startet git im Projektordner. Hooks des Projekts (`.git/hooks`, `.husky`, `.githooks`) hätten dabei mit dem Environment des Workers laufen können, also auch mit `DEV_LOG_SECRET_KEY` und `DEV_LOG_DATABASE_URL`. Ein Entwickler-Agent konnte `.husky/pre-commit` oder `.githooks/pre-commit` schreiben, weil `.githooks` in keiner Pfad-Sperrliste stand und die Datei-Werkzeuge des lokalen Modells `.husky` nicht kannten. Damit wäre die Env-Filterung der Agents umgangen worden.

## Umsetzung

Der zentrale Teil war schon vorhanden: `gitHelpers` nutzt `gitEnvironment` (`src/runner/project-command.ts`) mit `core.hooksPath=/dev/null`, ohne fsmonitor und mit gefiltertem Environment; Commits laufen mit `--no-verify`. Neu in diesem Auftrag:

- **Pfad-Sperren** (`src/agent/agent-guard.ts`): `.githooks` steht in `PROTECTED_PATH` (neben `.git` und `.husky`).
- **Datei-Werkzeuge** (`src/agent/tool-paths.ts`): `blockedPath` ist exportiert und nutzt die Menge `BLOCKED_PARTS` (`.git`, `.husky`, `.githooks`, `node_modules`, Sicherungsordner). Pfade werden an `/` und `\` getrennt, auch verschachtelte Hook-Ordner sind gesperrt.
- **Weitere git-Aufrufe mit gefiltertem Environment:**
  - `src/runner/git-sync/stale-lock.ts`: `git rev-parse` mit `gitEnvironment()`.
  - `src/runner/review-slots.ts`: `git rev-parse --git-common-dir` mit `gitEnvironment()`.
  - `src/setup/setup-jobs.ts`: `git` und `gh` (z. B. `gh repo create --push`) laufen mit `gitEnvironment` plus `GIT_TERMINAL_PROMPT`, `GIT_SSH_COMMAND` und `GH_PROMPT_DISABLED`; andere Befehle behalten das bisherige `ENV`.
- **Test** (`src/runner/git-sync/git-hooks.test.ts`, neu, 3 Tests):
  1. Echte Hooks (`.git/hooks/pre-commit`, `.husky/pre-commit`) schreiben eine Marker-Datei. Commit und Merge des Workers lassen den Marker aus.
  2. Gegenprobe: ohne Worker-Environment laufen die Hooks wirklich.
  3. `blockedPath` und der Claude-Wächter sperren `.git`, `.husky` und `.githooks`.
- **Doku:** `docs/laufzeit.md` (Abschnitt „Projektcode nur mit gefiltertem Environment“) und `docs/agents-und-rechte.md` (Geschützte Pfade).

## Geänderte Dateien

- `src/agent/agent-guard.ts`
- `src/agent/tool-paths.ts`
- `src/runner/git-sync/stale-lock.ts`
- `src/runner/review-slots.ts`
- `src/setup/setup-jobs.ts`
- `src/runner/git-sync/git-hooks.test.ts` (neu)
- `docs/laufzeit.md`
- `docs/agents-und-rechte.md`

Commit `e9208ae`.

## Worauf zu achten ist

- **Testlauf 40e2a746 (grün):** `npm run typecheck` bestanden. `npx tsx --test src/agent/agent-guard.test.ts src/agent/tool-paths.test.ts src/runner/git-sync/git-hooks.test.ts src/runner/git-sync/stale-lock.test.ts src/runner/review-slots.test.ts`: 56 Tests, 56 bestanden, 0 fehlgeschlagen. Der Code ist seitdem unverändert. Die Abnahme schlug nur fehl, weil der Tester den Lauf selbst nicht freigegeben bekam (DoD 1); das Ergebnis oben belegt den Hook-Test.
- **Noch ungeprüft:** `secret-holdback.test.ts` und `project-command.test.ts` waren nicht Teil des Laufs. Start ohne Coverage-Flags: `npx --no-install tsx --test src/runner/git-sync/secret-holdback.test.ts src/runner/project-command.test.ts`.
- **Test scheitert nicht vor dem Fix in allen Teilen:** Die Teile zu Commit und Merge waren schon grün, weil `gitHelpers` bereits `gitEnvironment` nutzte. Vor dem Fix scheitern nur die Prüfungen von `.githooks` und `.husky` in `blockedPath`.
- **Nicht angefasst:** `measured-coverage.ts:125` gehört zum Auftrag „Projektcode nur mit gefiltertem Environment ausführen“.
- **Offen:** Der Claude-Wächter sperrt `git config core.hooksPath` nicht gesondert (in `src/agent` kommt `hooksPath` nirgends vor). Für den Worker ist das unerheblich, da er `core.hooksPath=/dev/null` per `-c` setzt. Ein Agent kann aber die Git-Konfiguration ändern, wenn er sie über einen erlaubten Befehl erreicht.

## Sprint 23

| Auftrag | Zustand | Details |
| --- | --- | --- |
| 3691a610 Git-Hooks des Projekts im Worker nie ausführen | umgesetzt, 56/56 Tests grün (Lauf 40e2a746), Abnahme wartet auf Freigabe | `.githooks` gesperrt, `blockedPath` erweitert, weitere git-Aufrufe gefiltert, neuer Hook-Test |

## Anfrage / TODO

- Ergebnis von Lauf 40e2a746 für die Abnahme (DoD 1) werten; `secret-holdback.test.ts` und `project-command.test.ts` zusätzlich laufen lassen.
- Neuer Auftrag prüfen: `git config core.hooksPath` im Claude-Wächter sperren (Bereich backend, Schwere niedrig).
- `measured-coverage.ts:125` im Auftrag „Projektcode nur mit gefiltertem Environment ausführen“ ergänzen.
