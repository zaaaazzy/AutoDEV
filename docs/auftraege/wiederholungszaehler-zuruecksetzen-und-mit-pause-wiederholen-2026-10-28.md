# Wiederholungszähler zurücksetzen und mit Pause wiederholen

Auftrag 9894c0ef (Bugfix, Sprint 23). Aus dem Code-Review vom 21.10.2026 (Stand `a4971e9`).

## Problem

- `conflict_retries` wurde nie zurückgesetzt, auch nicht beim manuellen Retry. Nach zwei Konflikten führte jeder spätere Konflikt sofort zu „Blockiert“.
- Die Fehlversuche von „Vor dem Sprint“ wurden nur im Speicher des Workers gezählt (`failedAttempts`). Die drei Versuche liefen ohne Pause in aufeinanderfolgenden Zyklen (etwa alle 30 s). Ein Ollama-Ausfall von zwei Minuten verbrauchte alle Versuche.

## Umsetzung

### Konflikt-Zähler (`conflict_retries`)

Er wird auf 0 gesetzt:

- **Retry** („Erneut versuchen“, `src/api/development.ts`): im selben UPDATE wie Status und Hinweis.
- **„In Sprint übernehmen“** eines abgebrochenen Auftrags (`development.ts`, nur im Zweig `aborted`).
- **Erfolg:** gemergte Freigabe (`mergeApprovals` in `src/runner/review-gate.ts`) und Lauf mit Ergebnis „Erledigt“ (`settleItem` in `src/runner/runner-settle.ts`).

Bewusst nicht zurückgesetzt: beim Warten auf Freigabe.

### „Vor dem Sprint“ (`src/runner/pre-sprint.ts`)

- **Migration v15** (`src/db/migrations.ts`, idempotent): `sprints.pre_sprint_attempts` (SMALLINT, Standard 0) und `sprints.pre_sprint_next_at` (TIMESTAMPTZ). Die In-Memory-Map entfällt, der Zähler übersteht einen Neustart.
- **Wachsende Pause:** Nach einem Fehlversuch wird `pre_sprint_next_at` gesetzt (`preSprintRetryAt`): 2 Min. nach dem ersten, 4 Min. nach dem zweiten Fehlversuch (`PRE_SPRINT_RETRY_MS`, verdoppelt je Versuch).
- **Warten ohne Sperre:** `runPreSprint` überspringt den Sprint, solange die Pause läuft. Nach einem Fehlversuch (`attempts > 0`) liefert es `true`, die Aufträge warten also höchstens die Pausen der `PRE_SPRINT_ATTEMPTS` (3) Versuche. Danach starten sie ohne die Phase.
- **Erfolg:** `pre_sprint_next_at` wird mit `pre_sprint_at` und den Notizen auf `NULL` gesetzt.
- **Uhr injizierbar:** `runPreSprint(pool, options, agents, execute, now)`, Tests brauchen kein `sleep`.

### Nutzungslimit (`src/runner/autofix.ts`)

- `USAGE_LIMIT` erkennt jetzt auch zwei Wörter („You've hit your monthly spend limit“).
- Bei „Vor dem Sprint“ zählt ein Limit-Abbruch nicht als Fehlversuch. `pre_sprint_next_at` wird auf den Reset-Zeitpunkt gesetzt, der Limit-Text landet nie als Sprint-Hinweis.

## Tests

- `src/api/development-retry.test.ts`: Retry setzt `conflict_retries` auf 0.
- `src/runner/pre-sprint.test.ts`: Fehlversuche kurz hintereinander verbrauchen nicht alle Versuche (Pause mit injizierter Uhr), Zähler und Zeitpunkt am Sprint, Limit-Abbruch ohne Fehlversuch.
- `src/runner/review-gate-worktree.test.ts`: gemergte Freigabe setzt den Zähler zurück.
- `src/runner/autofix.test.ts`: „monthly spend limit“ wird erkannt.

Ausgeführt wurden die Tests von der Dokumentation nicht erneut.

## Geänderte Dateien

- `src/runner/pre-sprint.ts`, `src/runner/pre-sprint.test.ts`
- `src/runner/autofix.ts`, `src/runner/autofix.test.ts`
- `src/runner/review-gate.ts`, `src/runner/review-gate-worktree.test.ts`
- `src/runner/runner-settle.ts`
- `src/api/development.ts`, `src/api/development-retry.test.ts`
- `src/db/migrations.ts` (Migration v15)
- `docs/workflows.md`, `docs/benutzerhandbuch-freigabe-merge-agent-worktree.md`

## Worauf zu achten ist

- **Neue Spalten am Sprint:** Die Migration läuft beim Start. Bestehende Sprints beginnen mit 0 Versuchen.
- **Sprint-Start verzögert sich** nach einem Ausfall der Phase um bis zu 2 + 4 Minuten, danach startet er ohne „Vor dem Sprint“.
- **Offen:** „Zurückweisen“ (review-reject) setzt `conflict_retries` nicht zurück.
- Die Prettier-Meldungen zu `budget.test.ts` und `runner-budget-check.test.ts` stammen nicht von diesem Auftrag.

## Sprint 23 und Anfrage/TODO

- Zustand: Umsetzung abgeschlossen (Entwickler, bestanden), Dokumentation hier. Prüfung durch Tester und Reviewer steht noch aus.
- Die früheren „Bug-Wächter“-Bugs zu diesem Auftrag waren Abbrüche der Claude-CLI wegen des Spend-Limits, keine Code-Fehler.
- TODO: `review-reject` prüfen (Zähler zurücksetzen?); vollständigen Lauf mit `npm test` im Test-Gate prüfen.
