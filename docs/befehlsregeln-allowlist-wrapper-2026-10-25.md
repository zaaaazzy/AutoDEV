# Eigene Befehlsregeln per Allowlist, Wrapper wie timeout prüfen (25.10.2026)

Auftrag 17b80f99 (Bugfix, Sprint 23, aus dem Code-Review vom 21.10.2026, Stand `a4971e9`).

## Problem
- `customRuleProblem` ließ eigene Regeln wie `Bash(timeout:*)`, `Bash(nice:*)`, `Bash(find:*)`, `Bash(awk:*)`, `Bash(sed:*)`, `Bash(tee:*)`, `Bash(cp:*)` und `Bash(ln:*)` zu. Das war eine Sperrliste, die Lücken hatte.
- Der Wächter schälte `timeout`, `nice`, `stdbuf` und `ionice` nicht ab. `timeout 60 sh -c '…'` oder `timeout … git push` sah er nur als `timeout`. Breite Regeln in der DB hebelten so die Sperren aus.
- Shell-Builtins wie `export`, `cd`, `alias`, `source` und `eval` wurden nicht geprüft.
- Den Projektordner nahm der Hook aus `CLAUDE_PROJECT_DIR || cwd`, beides kann der Agent selbst beeinflussen.

## Änderung
- **`src/agent/command-checks.ts`**
  - `CUSTOM_RULE_PROGRAMS`: Allowlist für eigene Regeln (`git`, `npm`, `docker`, `make` und lesende Werkzeuge wie `ls`, `cat`, `grep`, `head`, `tail`, `wc`, `diff`, `jq`). `customRuleProblem` lehnt alles andere ab. Sie gilt für Claude-CLI und lokales Modell und steht nur einmal im Code.
  - `unwrapCommand`: schält `timeout`, `nice`, `stdbuf` und `ionice` in einer Schleife ab, bis zu vier Ebenen. Fail-closed (Ergebnis `null`) bei unklarer Option, Wert aus einer Variablen oder Glob, fehlendem Befehl oder mehr als vier Wrappern.
  - `SHELL_BUILTINS`: `export`, `declare`, `typeset`, `readonly`, `local`, `unset`, `set`, `shopt`, `alias`, `unalias`, `hash`, `cd`, `pushd`, `popd`, `source`, `.`, `eval`, `exec`, `trap`, `enable`, `builtin`, `command`, `let`. `forbiddenCommand` sperrt sie.
  - `awk`, `gawk`, `nawk` und `mawk` sind gesperrt (`system()`).
- **`src/agent/agent-guard.ts`**
  - `bashProblem` prüft jeden Teilbefehl nach dem Abschälen der Wrapper, mit eigener Meldung für unklare Wrapper und für Builtins.
  - `GuardPolicy` hat ein neues Feld `root`. `decodePolicy` übernimmt es nur als absoluten Pfad. Der Hook nimmt `policy.root` vor `CLAUDE_PROJECT_DIR` und `cwd`.
- **`src/agent/tool-permissions.ts`:** `guardHookCommand` und `withAgentPermissions` bekommen den Projektordner (`projectRoot`) und kodieren ihn in die Richtlinie, auch im Modus „Voller Zugriff“ (Geheimnis-Hook).
- **`src/runner/runner-agent.ts`, `src/agent/requirements.ts`:** reichen `options.cwd` als Projektordner durch. In `runner-agent.ts` bündelt die Hilfsfunktion `withRights` die vier bisherigen Aufrufe.
- **Doku:** neuer Absatz „Wrapper, Builtins und eigene Regeln“ in `docs/agents-und-rechte.md`.

## Tests
- `src/agent/agent-guard.test.ts` (neu): `timeout`/`nice`/`stdbuf`/`ionice` vor gesperrten Befehlen (`sh -c`, `git push`), verschachtelte Wrapper, Fälle, die fail-closed sperren, Builtins, `awk`. Gegenproben bleiben erlaubt: `npx --no-install tsx --test …`, `npm run typecheck`, `git fetch origin main`, `npm ci --ignore-scripts`, `timeout 60 npm test`. Hook-Test: die Wurzel aus der Richtlinie gewinnt gegen `CLAUDE_PROJECT_DIR`.
- `src/agent/tool-permissions.test.ts`: Allowlist lehnt die genannten Programme ab. Eine alte Regel in der DB (`Bash(timeout:*)`) wird beim Laden verworfen, ohne dass der Start abbricht.

- `e2e/app.spec.ts` (Test „Agent-Rechte …“): Die API lehnt `Bash(timeout:*)`, `Bash(find:*)`, `Bash(awk:*)`, `Bash(tee:*)` und `Bash(cd:*)` mit 400 ab; die Meldung enthält „nicht freigegeben“ oder „gesperrt“.

## Weitere Änderungen nach der Nachbesserung
- **Handbuch:** `docs/benutzerhandbuch-dashboard-agents.md` beschreibt abgelehnte Regeln in eigenen Rechte-Kategorien, mit drei Bildern unter `docs/benutzerhandbuch-dashboard-agents/` (`rechte-kategorie-abgelehnt.png`, `rechte-kategorie-gespeichert.png`, `rechte-kategorien-uebersicht.png`).
- **`e2e/playwright.config.ts`:** `testIgnore: ['**/tmp-*.spec.ts']`, damit Wegwerf-Skripte nicht im Testlauf landen.
- **Wegwerf-Skript:** `e2e/tmp-befehlsregeln-shots.spec.ts` hat die Handbuch-Bilder erzeugt und legt bei jedem Lauf eine Kategorie in der E2E-Datenbank an. Es muss vor dem Merge mit `git rm` gelöscht werden; der Entwickler durfte es nicht löschen.

## Worauf zu achten ist
- Stand der Übergabe: Weder der Entwickler noch ich konnten die Tests starten (fehlende Freigabe); Typecheck und Lint liefen ohne Fehler. Offen beim Tester: `npx --no-install tsx --test src/agent/agent-guard.test.ts src/agent/tool-permissions.test.ts src/agent/agent-permissions.test.ts` und `npm run test:e2e`. Der frühere E2E-Fehler kam nur vom Wegwerf-Skript.
- `cd` ist jetzt gesperrt. Testbefehle von Agents also ohne `cd … &&` schreiben, sonst blockt der Wächter.
- Bestehende eigene Gruppen mit nicht erlaubten Programmen (`find`, `sed`, `timeout` …) verlieren diese Regeln beim Laden stillschweigend. Wer sie braucht, muss eine enge Regel mit einem erlaubten Programm anlegen.
- Der Speicherpfad in `permission-groups.ts` nutzt dieselbe `customRuleProblem`-Prüfung und antwortet mit 400 und deutscher Meldung.
- Weitere Risiken: `docs/risiken/2026-10-25_auftrag-17b80f99-bug-waechter.md`.
