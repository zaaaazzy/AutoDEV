# Gemeinsame Liste geschützter Pfade für Claude- und Ollama-Wächter (25.10.2026)

Auftrag a034282d (Bugfix, aus dem Code-Review vom 21.10.2026, Stand `a4971e9`).

## Problem
Der Claude-Wächter (`PROTECTED_PATH` in `agent-guard.ts`) und die Datei-Werkzeuge des lokalen Modells (`BLOCKED_PARTS`/`blockedPath` in `tool-paths.ts`) hatten zwei verschiedene Listen. Auch die Pfadauflösung gab es dreimal (`realTarget`, `realPath`, `resolveInside`). Claude-Agents konnten deshalb in `node_modules/` und `.dev-log-backups/` schreiben, obwohl die Doku beides als gesperrt nennt. Ausserdem fehlten `.yarnrc*`, `.pnpmrc` und `.vscode/`. Das lokale Modell durfte dafür `.claude/`, `.mcp.json` und `.npmrc`-ähnliche Dateien wie `.yarnrc.yml` schreiben.

## Änderung
- **Neu: `src/agent/path-policy.ts`**
  - Eine Liste: `PROTECTED_DIRECTORIES` (`.git`, `.husky`, `.githooks`, `.claude`, `.vscode`, `node_modules`, `.dev-log-backups`, `.ssh`, `.aws`, `.gnupg`) und `PROTECTED_FILE` (`.mcp.json`, `.npmrc`, `.yarnrc*`, `.pnpmrc`), dazu `SECRET_NAME`.
  - `protectedPath(rel)` prüft jeden Pfadteil ohne Rücksicht auf Gross- und Kleinschreibung.
  - Eine Pfadauflösung: `realTarget` (null bei einem Link ins Leere) und `realPath` (nie null, für Befehlsargumente).
  - `checkProjectPath(root, path)` entscheidet für beide Wächter: Link ins Leere, ausserhalb des Projekts, geschützt (wie angegeben oder am aufgelösten Ziel) oder erlaubt.
  - `SECRET_NAME`, `SECRET_DIRECTORIES` und `BACKUP_DIRECTORY` stehen ebenfalls hier. `tool-paths.ts` exportiert `SECRET_NAME` und `BACKUP_DIRECTORY` für bestehende Importe weiter.
- **`agent-guard.ts`:** `PROTECTED_PATH`, `realTarget`, `inside` und `SECRET_DIRECTORIES` entfernt. `fileProblem` nutzt `checkProjectPath`. Neue Meldung: „… ist geschützt (Git, Hooks, Abhängigkeiten, Sicherungen, Einstellungen oder Geheimnisse).“
- **`tool-paths.ts`:** `BLOCKED_PARTS` und `blockedPath` entfernt. `resolveInside` nutzt `checkProjectPath`, die eigene Auflösungsschleife entfällt. Die Meldungen bleiben gleich.
- **`command-checks.ts`, `compose-check.ts`:** `realPath` kommt jetzt aus `path-policy.ts`.
- **Doku:** `docs/agents-und-rechte.md` (Abschnitt „Geschützte Pfade“), `docs/benutzerhandbuch-dashboard-agents.md` (Meldungstext und Liste).

## Tests
- Neu: `src/agent/path-policy.test.ts`. Dieselbe Tabelle für `fileProblem` und `resolveInside`:
  - Gesperrt: `node_modules`, `.dev-log-backups`, `.npmrc`, `.yarnrc`, `.yarnrc.yml`, `.pnpmrc`, `.vscode`, Hooks, `.claude`, `.mcp.json` und Geheimnisse.
  - Umgehungen: andere Gross- und Kleinschreibung, `..`, Links auf gesperrte Ziele, ein Link mit gesperrtem Namen (`frontend/node_modules -> ../vendor`), absolute Pfade.
  - Gegenproben bleiben erlaubt: `src/node_modules_info.ts`, `docs/node_modules.md`, `docs/npmrc.md`, `docs/yarnrc.md`, `src/vscode.ts`, `docs/husky.md`.
  - Ausserhalb des Projekts (`../`, Link nach draussen, `/etc/hosts`) melden beide Wächter gleich.
- Angepasst: `src/runner/git-sync/git-hooks.test.ts` nutzt `protectedPath` statt `blockedPath`.

## Hinweis
Das Lesen über die Datei-Werkzeuge des lokalen Modells ist jetzt auch für `.claude/`, `.vscode/`, `.mcp.json` und `.yarnrc*` gesperrt, weil `resolveInside` für Lesen und Schreiben dieselbe Richtlinie nutzt. Lesen von `node_modules/` war dort schon vorher gesperrt. Der Claude-Wächter sperrt beim Lesen weiter nur Geheimnisse.
