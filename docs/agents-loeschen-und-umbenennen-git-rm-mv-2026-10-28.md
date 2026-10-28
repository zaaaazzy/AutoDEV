# Agents: Dateien löschen und umbenennen mit `git rm` / `git mv`

Auftrag 49111ea3 (Bugfix, Sprint 23).

## Problem

Der Wächter sperrt alle Datei-Befehle (`FILE_COMMAND_NAMES` in `src/agent/command-checks.ts`: `rm`, `mv`, `cp` …). Die Datei-Werkzeuge können nicht löschen. Ein „Umbenennen“ wurde darum zur Kopie, das Original blieb liegen.

Beobachtet bei Mainty: Migrationen wurden auf eine freie Nummer „umbenannt“, die alte Datei blieb (25.10.: `009_checklist_items_is_required.sql` neben `010_…`; 28.10.: zwei `010_*.sql` auf `sprint/sprint-11`). Der Migrations-Runner meldete „Migration versions must be unique“, fünf Aufträge blockierten gleichzeitig. Kein Agent konnte es beheben.

## Umsetzung (`src/agent/`)

- `FILE_COMMAND_NAMES` bleibt unverändert: `rm`, `mv` und `cp` sind weiter gesperrt. Neu sind nur die eng geprüften Git-Unterbefehle `git rm` und `git mv`.
- `permission-rules.ts`: `GIT_RM_RULE` (`Bash(git rm:*)`), `GIT_MV_RULE` (`Bash(git mv:*)`) und `fileGitRules`. `git rm` gehört zu „Dateien ändern“, `git mv` braucht „Dateien anlegen“ und „Dateien ändern“. Beide Regeln haben eine deutsche Beschreibung (Hover); die Hilfetexte der Datei-Rechte nennen Löschen und Umbenennen.
- `tool-permissions.ts`: `withAgentPermissions` hängt `fileGitRules(policy)` an die Regeln, aber nur bei laufendem Wächter (`hook`). Rollen ohne Schreibrechte bekommen beides nie. `gitFileProblem` wird mit exportiert.
- `command-checks.ts`: neue Prüfung `gitFileProblem(words, root, files)`.
  - Erlaubte Optionen: `-q`/`--quiet`, `-n`/`--dry-run`, `--cached`, `-r` (rm), `-v`/`--verbose` (mv), genau so geschrieben. Kein `-f`/`--force`, kein `--pathspec-from-file`, keine Abkürzungen.
  - Quelle und Ziel: einfacher relativer Pfad ohne `..`, Platzhalter, Variablen, `~` und Pathspec-Magie; samt aufgelöster Links im Projekt bzw. in den erlaubten Ordnern; nicht das Projekt selbst; nicht geschützt (`checkProjectPath`: `.env`, `.git/`, `.claude/`, `.npmrc` – auch als Ziel).
  - Bei Ordnern wird darin nach geschützten Einträgen gesucht (höchstens 5000, sonst gesperrt).
- `agent-guard.ts`: `bashProblem` bekommt den neuen Parameter `files` (Datei-Rechte); `guardProblem` reicht die Richtlinie durch. Ohne `files` sind `git rm`/`git mv` gesperrt. Die Sperrmeldung nennt jetzt den erlaubten Weg.

## Worauf zu achten ist

- **Lokales Modell (Ollama):** `git rm`/`git mv` sind absichtlich noch nicht freigegeben, weil `isAllowedCommand` sie nicht kennt und `bashProblem` in `ollama-tools.ts` keine Datei-Rechte bekommt. Folgeauftrag.
- **Grenze:** `git rm` löscht nur Dateien, die Git kennt. Eine im selben Schritt neu angelegte, nicht committete Datei lässt sich so nicht löschen.
- **Breite eigene Regeln** wie `Bash(git:*)` umgehen die Prüfung nicht: der Wächter prüft jeden Aufruf. Ketten mit `rm`/`mv`/`cp`, Wrapper (`command`, `env`) und `git -C` bleiben gesperrt; `timeout 30 git rm …` wird wie `git rm …` geprüft.
- **Formatierung:** Prettier lief auf den geänderten Dateien nicht. In `permission-rules.ts` fehlt ein Leerzeichen (`PSEUDO_COMMANDS =new Set`). Vor dem Merge `prettier --write` ausführen.
- Ein echter Lauf mit der Claude-CLI (committete Datei mit `git mv` umbenennen, Original danach weg) steht aus.

## Tests

- `agent-guard.test.ts` („git rm und git mv …“): erlaubte und gesperrte Fälle, Umgehungsversuche (Ketten, Anführungszeichen, Wrapper, Abkürzungen, Pfade ausserhalb, geschützte Dateien), Gegenprobe `rm`/`mv`/`cp`.
- `agent-permissions.test.ts`, `tool-permissions.test.ts`: Regeln je Rechte-Kombination.
- Von der Dokumentation nicht erneut ausgeführt.

## Geänderte Dateien

- `src/agent/command-checks.ts`, `agent-guard.ts`, `permission-rules.ts`, `tool-permissions.ts`
- `src/agent/agent-guard.test.ts`, `agent-permissions.test.ts`, `tool-permissions.test.ts`
- `docs/agents-und-rechte.md` (Abschnitt „Löschen und Umbenennen“), `docs/benutzerhandbuch-dashboard-agents.md` (Abschnitt 3 und Fehlermeldungs-Zeile)

## Sprint 23 / Anfrage-TODO

- Auftrag 49111ea3: umgesetzt (Entwickler), Dokumentation fertig; Test und Review stehen aus.
- Offen: Folgeauftrag für das lokale Modell (siehe oben); echter CLI-Lauf; Prettier.
