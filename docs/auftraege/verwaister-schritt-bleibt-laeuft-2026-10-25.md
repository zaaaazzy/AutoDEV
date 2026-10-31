# Verwaister Schritt bleibt „läuft“, wenn der Abschluss an der Datenbank scheitert

Auftrag 4b931cb3 (Bugfix, Schwere mittel, gefunden am 21.10.2026). Sprint 23.

## Ursache

Fällt die Datenbank aus, während ein Auftrag abgeschlossen wird, scheitern `settleItem`, `blockStuckItem` und das Schliessen des Laufs. Der Schritt bleibt in `agent_run_steps` auf `running`, der Lauf in `agent_runs` ebenfalls, ohne Prozess dahinter. `recoverStuckItems` greift nicht, weil der Lauf als laufend gilt. Nur ein Worker-Neustart (`recoverInterruptedRuns`) räumte auf. „Abbrechen“ wirkte nicht, weil kein Schritt mehr den Abbruch abfragt.

## Umsetzung

- **Abschluss wiederholen** (`src/runner/runner.ts`, finally in `runWorkItem`): `retryOnDatabase` wiederholt `blockStuckItem` und das Schliessen des Laufs bei Datenbankausfall bis zu fünfmal mit 15 s Pause (`SETTLE_RETRY_DELAY_MS`, über `settleRetryDelayMs` in `WorkItemOptions` überschreibbar). `isDatabaseUnavailable` erkennt nur Verbindungsfehler (ECONNREFUSED, ECONNRESET, Klasse 08, 57P01–03, auch als `AggregateError`). SQL-Fehler gehen sofort weiter und werden nicht als Ausfall gezählt. `settleItem` selbst wird nicht wiederholt, damit Merge und Commit nicht doppelt laufen.
- **Eigene Läufe merken** (`heldRuns`, `heldRunIds()`): Der Worker trägt einen Lauf nach `claimRun` ein und nimmt ihn heraus, sobald das Schliessen versucht wurde oder der Start scheiterte.
- **Aufräumen ohne Neustart** (`closeOrphanedRuns(pool, projects, held, staleMs)`): Eine einzige SQL-Anweisung, mehrfach ausführbar. Sie trifft Läufe auf `running` in den Projekten dieses Workers, die er nicht hält und deren letztes Lebenszeichen älter als `ORPHANED_RUN_MS` (5 min) ist. Lebenszeichen sind Laufstart, Schrittstart und der letzte Eintrag im Verlauf. Der Lauf wird `failed`, der Schritt `failed` mit „Unterbrochen: …“ und `interrupted`, der Auftrag auf „In Arbeit“ wird wieder „Geplant“. Verwaist derselbe Auftrag ein drittes Mal (`ORPHANED_REQUEUE_LIMIT` = 2), wird er blockiert statt endlos neu eingeplant. Tokens und Kosten bleiben unberührt.
- **Abbrechen** (`src/runner/runner.ts`, `src/api/agent-cancel.ts`): Ein Schritt mit `cancel_requested` ohne Prozess endet nach `ORPHANED_CANCEL_MS` (30 s) Lebenszeichen-Alter mit Exit-Code 130 und dem Hinweis „Vom Benutzer abgebrochen …“, der Auftrag wird blockiert. `cancelAgent` selbst ist unverändert, nur der Kommentar nennt den neuen Weg.
- **Takt** (`src/runner/runner-cli.ts`): Der 15-s-Heartbeat ruft `closeOrphanedRuns` für die bekannten Projekte auf, nie zwei Durchgänge gleichzeitig (`orphanCheckActive`), nicht beim Beenden.

## Tests (`src/runner/runner.test.ts`)

- Datenbank wirft beim Abschluss viermal ECONNREFUSED und ist dann zurück: Lauf geschlossen, vom Worker freigegeben.
- SQL-Fehler werden nicht wiederholt; bei Ausfall gibt der Abschluss nach fünf Versuchen auf.
- Abschluss scheitert endgültig: Lauf freigegeben, `closeOrphanedRuns` prüft die Bedingungen; gehaltene Läufe bleiben unberührt.
- Der bestehende Aussetzer-Test nutzt `settleRetryDelayMs: 0`.

## Geänderte Dateien

- `src/runner/runner.ts`
- `src/runner/runner-types.ts`
- `src/runner/runner-cli.ts`
- `src/runner/runner.test.ts`
- `src/api/agent-cancel.ts`
- `docs/workflows.md` (Abschnitt Laufzeit: „Verwaiste Läufe ohne Neustart“)
- `docs/laufzeit.md` (Heartbeat-Takt)

## Worauf zu achten ist

- **Wartezeit:** Nach Rückkehr der Datenbank steht ein verwaister Lauf spätestens nach etwa 5 min plus einem Takt (15 s) nicht mehr auf „läuft“. Ein abgebrochener Schritt endet nach höchstens etwa 45 s.
- **Mehrere Worker:** Jeder Worker räumt nur Läufe seiner Projekte auf, die er selbst nicht hält. Ein Lauf eines zweiten, lebenden Workers mit frischem Lebenszeichen bleibt unangetastet; ein Schritt ohne Eintrag im Verlauf länger als 5 min gälte aber als verwaist.
- **Tests:** Entwickler und Dokumentierer konnten die Tests nicht ausführen (Freigabe fehlte). Der Tester soll gezielt `npx --no-install tsx --test src/runner/runner.test.ts` starten, ohne `--experimental-test-coverage`. Prettier lief nicht, lange Zeilen wurden von Hand umgebrochen.
