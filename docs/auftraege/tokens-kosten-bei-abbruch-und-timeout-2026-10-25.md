# Tokens und Kosten auch bei Abbruch und Timeout zählen (25.10.2026)

Auftrag 150d7266 (Bugfix, Sprint 23, aus dem Code-Review vom 21.10.2026, Stand `a4971e9`).

## Problem
- `claude-stream.ts` zählte nur Tokens aus dem `result`-Ereignis. Bei Zeitlimit, „Abbrechen“ oder Absturz der Claude-CLI fehlt es, gebucht wurde 0.
- Die `message.usage` der `assistant`-Ereignisse wurde ignoriert.
- Folge: Lange Entwicklerläufe, die ins Zeitlimit liefen, zählten nicht zum Tages- und Sprintbudget, obwohl sie am meisten verbrauchen.

## Änderung (`src/agent/claude-stream.ts`)
- Typen: `Usage` ist jetzt ein eigener Typ; `StreamEvent.message` trägt `id` und `usage`.
- `createStreamParser` merkt sich je `message.id` den letzten Stand der `usage` (`messageTokens`, eine `Map`). Claude schickt eine Nachricht je Inhaltsblock erneut mit derselben id und wachsendem Stand, darum zählt nur der letzte. Ereignisse ohne id erhalten einen eigenen Schlüssel.
- Neue Methode `streamedTokens()` im `StreamParser`: Summe über alle Nachrichten.
- `executeAgentCommand`: Fehlt das `result`-Ereignis, gilt `tokens = parser.streamedTokens() || result.tokens`. Das gilt für Exit ≠ 0 (Abbruch, Timeout, Absturz) und für Exit 0 ohne `result` (zählt weiter als Fehlschlag). Die Tokens laufen über denselben Weg wie die aus `result` und werden in `steps.ts` gebucht; die Buchung hängt nicht am Schritt-Status `failed`.
- Ist `result` vorhanden, gilt nur `result`, die `usage` der `assistant`-Ereignisse zählt nicht zusätzlich.
- Kosten werden nicht geschätzt: `costUsd` bleibt der Wert vom Prozess (0 ohne `result`). Ist auch die Summe 0, bleibt `tokens` unverändert.

## Tests (`src/agent/claude-stream.test.ts`)
- Bestehender Abbruchtest (`:86`) bewusst erweitert: Ohne `usage` bleibt `tokens` leer.
- Neu: Abbruch mit SIGKILL, dieselbe `message.id` zweimal mit wachsendem Stand plus eine zweite Nachricht: 1308 Tokens, Kosten 0.
- Neu: `result` vorhanden, `usage` der `assistant`-Ereignisse zählt nicht mit (15 statt 1015 Tokens).
- Neu: Exit 0 ohne `result` gilt als Fehlschlag, die Tokens zählen trotzdem (10).

## Doku
- `docs/benutzerhandbuch-dashboard-agents.md`: Punkt „Tokens zählen auch ohne Ergebnis-Ereignis“.
- `docs/laufzeit.md`: Absatz zum Abbruch ergänzt.

## Worauf zu achten ist
- **Keine Kosten in US-Dollar bei Abbruch:** Die CLI meldet sie nur im `result`-Ereignis. Das Dollar-Budget sieht abgebrochene Läufe weiterhin nicht; nur das Token-Budget wird jetzt belastet.
- **Stand der Prüfung:** Der Entwickler konnte die neuen Tests nicht ausführen, weil der Wächter den Lauf blockierte. Ein Testlauf `npx --no-install tsx --test src/agent/claude-stream.test.ts` (ohne Abdeckungs-Flags) steht aus; dass die neuen Tests ohne den Fix rot sind, ist nicht belegt.
- **Schönheitsfehler:** In `claude-stream.ts` steht `const action =(message: string)` ohne Leerzeichen nach `=`. Funktional ohne Wirkung.
- Der Rückfall ist eine Summe aus `input`, `output` und den Cache-Tokens, wie sie `usageTokens` auch für `result` bildet.

## Geänderte Dateien
`docs/benutzerhandbuch-dashboard-agents.md`, `docs/laufzeit.md`, `src/agent/claude-stream.ts`, `src/agent/claude-stream.test.ts`.
