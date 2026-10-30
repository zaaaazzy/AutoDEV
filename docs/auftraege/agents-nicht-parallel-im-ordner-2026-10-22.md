# Agents nicht parallel im selben Arbeitsordner (22.10.2026)

Auftrag ddd1e74e, Bugfix aus dem Code-Review vom 20.10.2026.

## Problem

- Chat-Assistent und `draftRequirements` liefen parallel zu `runWorkflow` im selben Ordner. Führte der Assistent während des Entwickler-Schritts `git checkout main` aus, committete `commitAgentStep` die Änderungen des Entwicklers auf `main`.
- Die Ordner-Sperre (`acquireTree`) galt nur im eigenen Prozess. Ein zweiter Worker (Host und Container, `runner-cli` ohne `--all`) sperrte nicht mit.
- Zwei Projekte mit demselben Repository oder Agent-Worktree starteten gleichzeitig und warteten unbemerkt auf die Sperre.

## Umsetzung

- **Autoren-Agents standardmäßig nur lesend.** `runAuthorAgent` (`requirements.ts`) hat `readOnly = true` als Standard. Das gilt für Auftragsautor, Bug-Wächter, Visionär, Analyse, Abnahme und Sprint-Kommentar. Schreiben darf nur, wer den Ordner hält und ausdrücklich `false` übergibt.
- **Chat:** `claimChatTree` (`chat.ts`) prüft und nimmt den Ordner in einem Schritt über `tryAcquireTree`. Ist er belegt, antwortet der Assistent nur lesend, sonst hält er ihn bis zum Ende der Antwort.
- **Prozessübergreifende Sperre** (`core/project-lock.ts`): `shareTreeLocks(pool)` (in `runner-cli.ts` beim Start gesetzt) ergänzt die Sperre im Speicher um einen Postgres-Advisory-Lock auf einer eigenen Verbindung. Schlüssel immer `treeLockName` = `aideation-tree:<realpath>`. Stirbt ein Worker, gibt Postgres den Lock selbst frei, es bleibt keine verwaiste Sperre. Reihenfolge überall: erst lokal, dann Datenbank. Ohne Datenbank (Tests) gilt die Sperre nur im Prozess.
- **Wartehinweis:** `acquireTree(path, onWait)` meldet einmal „wartet auf Arbeitsordner“ im Log. Das ist kein Fehler und löst keinen Autofix aus.
- **Ein Ordner, ein Auftrag.** `folderInUseBy` und `activeFolders` in `runner-cli.ts` starten kein zweites Projekt im selben echten Ordner (auch über Symlink).
- **`documenter` in `TREE_ROLES`** (`runner.ts`): Der Dokumentierer committet das Benutzerhandbuch und braucht die Sperre auch bei reinen Doku-Aufträgen.

## Geänderte Dateien

- `src/core/project-lock.ts`, `src/core/project-lock.test.ts`
- `src/agent/chat.ts`, `src/agent/chat-tree.test.ts` (neu: echtes Git-Repo, Symlink, Fake-Assistent führt `git checkout main` aus, mit Gegenprobe)
- `src/agent/requirements.ts`, `src/agent/requirements.test.ts`
- `src/runner/runner.ts`, `src/runner/runner-cli.ts`, `src/runner/runner-cli.test.ts`
- `src/runner/autofix.test.ts`

## Worauf zu achten ist

- Neue Agents, die Dateien ändern, müssen `acquireTree`/`tryAcquireTree` nehmen und `readOnly = false` übergeben. Sonst laufen sie nur lesend.
- Die Sperre nur im `finally` freigeben. Nie ein rohes `cwd` als Schlüssel nehmen, immer `realpath` (`treeLockName`).
- Offen: „Wartet auf Arbeitsordner“ steht nur im Log, nicht in der Oberfläche. Zeigen Host und Container über verschiedene Pfade auf denselben Ordner, entstehen zwei Schlüssel und die Sperre schützt nicht. `verifyAcceptance` läuft weiter ohne Shell.
- Tests: Plattform-Lauf der 7 betroffenen Testdateien 81/81 grün, Typecheck grün. Der Entwickler meldete `npm test` 1096/1096. Der Tester konnte `npm test` wegen des Agent-Wächters nicht selbst starten.
