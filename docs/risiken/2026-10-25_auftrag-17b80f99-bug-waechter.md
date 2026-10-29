# Bug-Wächter: Risiken für Auftrag 17b80f99 (Eigene Befehlsregeln per Allowlist, Wrapper wie timeout prüfen)

Stand: `08468f8`, Sprint 23. Die Fundstellen im Auftrag (`tool-permissions.ts:581`, `agent-guard.ts:167-169`) stimmen nicht mehr. Die Logik liegt jetzt hier:

- `src/agent/command-checks.ts`: `customRuleProblem` (~432), `FORBIDDEN_COMMAND_NAMES` (~268), `FILE_COMMAND_NAMES` (~276, enthält schon `nice|timeout|find`-nahe Wrapper), `forbiddenCommand` (~289)
- `src/agent/agent-guard.ts`: `WRAPPERS` (:75), `bashProblem` (:175, Wrapper-Zweig :198), Projektwurzel `process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()` (:306)

Prüfe vor dem Ändern, was `forbiddenCommand` heute schon sperrt. `timeout` und `nice` stehen bereits in `FILE_COMMAND_NAMES`. Der Wächter sperrt also direkt aufgerufene Befehle. Die Lücke liegt bei den eigenen Regeln: `customRuleProblem` prüft nur `FORBIDDEN_COMMANDS`, also nicht `FILE_COMMAND_NAMES`. Das Test-Szenario muss beide Wege abdecken (Regel speichern und Befehl ausführen).

## Relevante frühere Bugs und was nicht wiederholt werden darf

1. **Agent-Wächter: Umgehung der Shell-Prüfungen über escapte Anführungszeichen** (behoben)
   - Nicht wiederholen: Prüfungen auf dem Rohtext der Befehlszeile. Alle neuen Prüfungen (Wrapper abschälen, Builtins) laufen auf den Wörtern aus `parseShell` (`words[].text`), nicht per Regex auf `command`.
   - Teste die Umgehungen: `"timeout"`, `\timeout`, `/usr/bin/timeout`, `$X 60 git push`, `t""imeout`.
2. **Tester: Geheimnisse-Platzhalter / Gemeinsame Pfad-Richtlinie** (offene Berichte in `docs/tests/2026-10-25_*`)
   - Nicht wiederholen: eine zweite Liste neben der gemeinsamen Pfad-Richtlinie pflegen. Die Allowlist und die Wrapper-Liste nur an einer Stelle definieren, die Claude-Wächter und Ollama-Wächter gemeinsam nutzen.
3. **Wächter blockiert Befehle mit `--experimental-test-coverage`** (Sprint-Bug „Abdeckung nicht messbar")
   - Nicht wiederholen: neue Sperren, ohne die Test- und Abnahme-Befehle der Agents zu prüfen. Nach der Änderung müssen `npx --no-install tsx --test …`, `npm run typecheck` und `git fetch origin main` weiter durchgehen. Gegenproben gehören in die Tests. Eine Allowlist ist strenger als die Sperrliste und kann Agent-Läufe lahmlegen.
4. **SQL-Wächter: Kommentare in Strings und DELETE in CTE/EXPLAIN**
   - Nicht wiederholen: nur die offensichtliche Form prüfen. Wrapper können verschachtelt sein (`timeout 5 nice -n 5 stdbuf -o0 git push`). Schäle in einer Schleife ab und begrenze die Tiefe. Nach der Grenze wird gesperrt (fail-closed).
5. **Schema: bugs_source_check ohne 'github' verhindert den Start** und **Autofix: ENOENT als Umgebungsfehler**
   - Nicht wiederholen: bestehende DB-Zeilen nicht berücksichtigen. Alte breite Regeln (`Bash(timeout:*)`) liegen schon in der DB. `tool-permissions.ts:89-93` filtert sie beim Laden mit `customRuleProblem`. Die strengere Prüfung darf daher beim Start nichts abbrechen. Sie muss die Regeln nur verwerfen. Ein Test mit einer alten Regel in der DB ist nötig. Prüfe, ob die Nutzer eine Meldung bekommen, welche Regeln verworfen wurden.
6. **Tester: Auftragsstatus / Sprint-PATCH / POST /docs** (Eingaben und API-Rechte)
   - Betrifft die API in `src/api/permission-groups.ts:32`: Beim Speichern dieselbe Prüfung verwenden wie beim Laden und im Wächter, mit Meldung auf Deutsch und Status 400.
7. **Mehrfach: Tester meldet „Wächter blockiert Befehl“, Auftrag bleibt hängen**
   - Nicht wiederholen: Testläufe mit Befehlen, die der eigene Wächter sperrt. Im Test die Wächter-Funktionen direkt aufrufen (`bashProblem`, `customRuleProblem`), nicht über eine echte Shell.

## Konkrete Anforderungen aus dem Auftrag und dem Review-Plan

- Allowlist erlaubter Programme für eigene Regeln statt der Sperrliste. Unbekannte Programme sind gesperrt.
- Wrapper `timeout`, `nice`, `stdbuf`, `ionice` abschälen und den Befehl dahinter wie einen direkten Befehl prüfen (Optionen und Zahlen der Wrapper überspringen, etwa `-n 5`, `-k 3`, `60`). Sind die Optionen nicht eindeutig zu erkennen, gilt der Befehl als gesperrt.
- Builtins sperren: `export declare unset set alias cd pushd source . eval trap`. Auch `typeset` und `exec` bleiben gesperrt.
- Projektwurzel aus der kodierten Policy statt aus `CLAUDE_PROJECT_DIR || cwd` (`agent-guard.ts:306`).
- Tests für die Beispiele aus dem Auftrag: `timeout 60 sh -c '…'`, `find -exec`, `awk system()`, `sed -i`, `tee`, `cp`, `ln`, `timeout … git push` mit einer breiten Regel `Bash(git:*)`. Dazu Gegenproben für erlaubte Befehle.
- Ändere `FILE_COMMAND_NAMES` nur zusammen mit dem Test für `acceptEdits` (`mkdir touch rm rmdir mv cp sed` ohne Regel).
- Doku: die Beschreibung der eigenen Befehlsregeln unter `docs/` anpassen, falls vorhanden.
