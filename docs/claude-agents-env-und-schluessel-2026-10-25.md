# Claude-Agents dürfen .env und Schlüssel nicht lesen

Auftrag f4582d2b (Bugfix, Sprint 23, 25.10.2026). Gefunden im Code-Review vom 21.10.2026 (Stand `a4971e9`).

## Ausgangslage

Gemeldet war: Der Wächter-Hook griff nur bei `Write|Edit|MultiEdit|NotebookEdit|Bash`, `Read`, `Grep` und `Glob` blieben ungeprüft, und es gab keine Deny-Regeln für Geheimnisse. Beim Start dieses Auftrags war der größte Teil davon im Code schon vorhanden: `SECRET_READ_DENY` in `tool-permissions.ts`, der Hook für `Read|Grep|Glob|NotebookRead` und `secretReadProblem` in `agent-guard.ts` (Pfad normalisieren, `SECRET_NAME` prüfen, bei Grep auch `glob`, bei Glob das Muster). Die Lücke, die übrig war: Zugangsdaten-Dateien wie `.npmrc` (Registry-Tokens) wurden von `SECRET_NAME` und den Deny-Regeln nicht erfasst. Sie landeten damit weiter im Klartext in `chat_messages`, in der Anfragen-Doku und bei der API.

## Umsetzung

- **`SECRET_NAME`** (`src/agent/tool-paths.ts`): erkennt zusätzlich die ganzen Dateinamen `.npmrc`, `.netrc` und `.git-credentials`. Dieselbe Prüfung nutzen Claude-Wächter und Ollama-Agent, beide lesen und listen diese Dateien damit nicht mehr.
- **Deny-Regeln** (`SECRET_READ_DENY` in `src/agent/tool-permissions.ts`): neu `Read(**/.npmrc)`, `Read(**/.netrc)`, `Read(**/.git-credentials)` und dieselben drei unter `~`. Sie gelten für jede Rolle über `--settings`; die CLI wendet sie auch auf Grep und Glob an.
- **Tests:**
  - `tool-paths.test.ts`: neue Treffer (`.npmrc`, `.netrc`, `.git-credentials`) und Nicht-Treffer (`npmrc.md`, `.npmrc.md`, `keyboard.ts`).
  - `agent-guard.test.ts`: Read, Grep (`path` und `glob`) und Glob auf `.npmrc`, `frontend/.npmrc`, `~/.npmrc`, `~/.netrc`, `.git-credentials`, `.env.example` sind gesperrt. Gegenproben `environment.ts`, `keyboard.ts` und `npmrc.md` bleiben lesbar.
  - `agent-permissions.test.ts`: jede Rolle bekommt `Read(**/.npmrc)`.
- **Doku:** `docs/agents-und-rechte.md`, Absatz „Geheimnisse sind für jeden Claude-Agent unlesbar“.

## Geänderte Dateien

- `src/agent/tool-paths.ts`
- `src/agent/tool-permissions.ts`
- `src/agent/tool-paths.test.ts`
- `src/agent/agent-guard.test.ts`
- `src/agent/agent-permissions.test.ts`
- `docs/agents-und-rechte.md`

Commit `0071d15`.

## Worauf zu achten ist

- **Testlauf:** `npm test` lief grün (1449/1449), ohne Abdeckungsmessung. Die neuen Tests wurden erst nach der Änderung geschrieben und nicht vor dem Fix rot gesehen. `npx --no-install tsx --test src/agent/agent-guard.test.ts` brauchte für den Entwickler eine Freigabe; der Tester sollte es ohne Coverage-Flags starten.
- **Offene Grenze:** Ein Grep über einen ganzen Ordner prüft der Wächter nicht Datei für Datei. Dort greifen nur die Deny-Regeln der CLI (in der Doku vermerkt).
- **Shell:** `cat .env` und ähnliche Wege über `Bash` sperrt weiterhin `SECRET_IN_COMMAND`. Ob dort auch `.npmrc`, `.netrc` und `.git-credentials` erfasst sind, wurde in diesem Auftrag nicht geprüft.
- **Bewusst gesperrt:** `.env.example` bleibt unlesbar, weil `SECRET_NAME` alles ab `.env` erfasst; der Test hält das fest.
- Die System-Agents (Analyse, Schätzung, `readOnlyCommand`) laufen nicht über `withAgentPermissions` und sind nicht Teil der Änderung.

## Sprint 23

| Auftrag | Zustand | Details |
| --- | --- | --- |
| f4582d2b Claude-Agents dürfen .env und Schlüssel nicht lesen | umgesetzt, `npm test` 1449/1449 grün, Tester-Prüfung offen | `.npmrc`, `.netrc`, `.git-credentials` in `SECRET_NAME` und Deny-Regeln, neue Wächter-Tests |
