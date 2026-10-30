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

## Akzeptanzkriterien und Belege (alle grün im Testlauf vom 25.10.2026)

| Kriterium | Test |
| --- | --- |
| Eigene Regeln nur per Allowlist: `timeout`, `nice`, `stdbuf`, `ionice`, `find`, `awk`, `sed`, `tee`, `cp`, `ln`, Builtins abgelehnt | `tool-permissions.test.ts` „customRuleProblem: nur Programme aus der Allowlist …“; `e2e/app.spec.ts` (API 400) |
| Speichern über die API mit 400 und deutscher Meldung | `e2e/app.spec.ts` „Agent-Rechte …“ |
| Alte breite Regeln in der DB gelten nicht mehr, der Start bricht nicht ab | `tool-permissions.test.ts` „loadProjectPermissions: alte Regeln mit Wrappern …“ |
| Wächter schält Wrapper ab und prüft den Befehl dahinter (`timeout 60 sh -c …`, `timeout … git push`, verschachtelt, Umgehungen mit Quotes, Pfad, `$X`) | `agent-guard.test.ts` „Wächter: hinter timeout, nice, stdbuf und ionice …“ |
| Unklare Wrapper-Optionen, fehlender Befehl, zu tiefe Verschachtelung: gesperrt | derselbe Test, zweiter Block |
| Builtins `export`, `declare`, `unset`, `set`, `alias`, `cd`, `pushd`, `source`, `.`, `eval`, `trap` gesperrt | `agent-guard.test.ts` „Wächter: Shell-Builtins …“ |
| `awk system()` gesperrt; Gegenproben `npx --no-install tsx --test …`, `npm run typecheck`, `git fetch origin main`, `npm ci --ignore-scripts` erlaubt | `agent-guard.test.ts` „Wächter: awk …“ |
| Projektwurzel des Hooks aus der kodierten Richtlinie | `agent-guard.test.ts` „Wächter als Hook: Projektordner aus der Richtlinie …“ |

## Weitere Änderungen nach der Nachbesserung
- **Handbuch:** `docs/benutzerhandbuch-dashboard-agents.md` beschreibt abgelehnte Regeln in eigenen Rechte-Kategorien, mit drei Bildern unter `docs/benutzerhandbuch-dashboard-agents/` (`rechte-kategorie-abgelehnt.png`, `rechte-kategorie-gespeichert.png`, `rechte-kategorien-uebersicht.png`).
- **`e2e/playwright.config.ts`:** `testIgnore: ['**/tmp-*.spec.ts']`, damit Wegwerf-Skripte nicht im Testlauf landen.
- **Wegwerf-Skript:** `e2e/tmp-befehlsregeln-shots.spec.ts` hat die Handbuch-Bilder erzeugt und legt bei jedem Lauf eine Kategorie in der E2E-Datenbank an. Es muss vor dem Merge mit `git rm` gelöscht werden; der Entwickler durfte es nicht löschen.

## Worauf zu achten ist
- Stand der Prüfung (Testlauf des Testers, 25.10.2026): `npx tsx --test src/agent/agent-guard.test.ts src/agent/requirements.test.ts src/agent/tool-permissions.test.ts` grün, 99 von 99. `npx playwright test -c e2e/playwright.config.ts e2e/app.spec.ts` grün, 72 bestanden und 2 übersprungen. Darin enthalten ist die Ablehnung der Wrapper- und Schreibregeln über die API. `npm run typecheck` ist grün. Der frühere E2E-Fehler kam nur vom Wegwerf-Skript `e2e/tmp-befehlsregeln-shots.spec.ts`, das jetzt per `testIgnore` übersprungen wird.
- `cd` ist jetzt gesperrt. Testbefehle von Agents also ohne `cd … &&` schreiben, sonst blockt der Wächter.
- Bestehende eigene Gruppen mit nicht erlaubten Programmen (`find`, `sed`, `timeout` …) verlieren diese Regeln beim Laden stillschweigend. Wer sie braucht, muss eine enge Regel mit einem erlaubten Programm anlegen.
- Der Speicherpfad in `permission-groups.ts` nutzt dieselbe `customRuleProblem`-Prüfung und antwortet mit 400 und deutscher Meldung.
- Weitere Risiken: `docs/risiken/2026-10-25_auftrag-17b80f99-bug-waechter.md`.
