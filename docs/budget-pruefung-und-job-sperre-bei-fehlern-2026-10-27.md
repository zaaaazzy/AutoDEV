# Budget-Prüfung und Job-Sperre bei Fehlern sicher

Auftrag c1fb5014 (Bugfix, Sprint 23). Aus dem Code-Review vom 21.10.2026 (Stand `a4971e9`).

## Problem

- Scheiterte die Budgetabfrage (`budgetGate(ctx).catch(logged(…, null))`), galt das Budget als nicht erreicht. Bei kurzen Datenbankstörungen starteten Agent-Schritte ohne Budgetprüfung.
- Bei Wartungs-Jobs brach `runWithTimeout` nur das Promise-Rennen ab. `finishJob` gab die Sperre sofort frei, obwohl der Job weiterlief. Ein langsamer `closeOldSprints` und der nächste Durchgang überschnitten sich (doppeltes `completeSprint`, doppelte Push-Nachrichten).

## Umsetzung

### Budget-Prüfung (`src/runner/runner-context.ts`, `runner.ts`, `runner-steps.ts`)

- **`guardedBudgetGate`** ersetzt das stille `.catch(…, null)`. Scheitert die Abfrage, liefert es `failed` mit Begründung statt „nicht erreicht“.
- **Kein Start ohne Prüfung:** `runWorkItem` startet den Agent nicht, setzt den Auftrag als unterbrochen und bricht den Durchgang ab. Das gilt für alle Schrittarten, die über `runStep` laufen.
- **`recordBudgetCheckFailure`** schreibt in einer Anweisung (eine Transaktion) einen unterbrochenen Schritt des Agents mit der Ursache und setzt `failure` und `retry_after` am Auftrag. Kein Bug, keine Budget-Blockade.
- **Keine Endlosschleife:** `retry_after` hält den Auftrag `BUDGET_CHECK_RETRY_MS` (5 min) zurück. Danach setzt derselbe Agent fort.
- **Zweiter Versuch** nach vorübergehendem Fehler (`runStep`): Ist das Budget dann nicht prüfbar, gibt es keinen Versuch. Der Schritt wird unterbrochen, Tokens und Kosten des ersten Versuchs bleiben erhalten.
- **Beobachter** („Bei abgeschlossen/abgelehnt“): Bei nicht prüfbarem Budget startet keiner mehr.
- Die Abgrenzung des Sprintbudgets (nur Läufe der Sprint-Aufträge, Auftrag 1ddaeb4b) bleibt unverändert; auch dieser Fehlerfall ist getestet.

### Job-Sperre (`src/runner/scheduler.ts`)

- **`runWithTimeout`** startet den Task, löst beim Zeitlimit das Abbruchsignal aus und wartet bis zu `TIMEOUT_GRACE_MS` (20 s) auf sein echtes Ende. Läuft er dann noch, wirft es `JobTimeoutError` mit dem laufenden Promise.
- **`runJob` / `finishJob`:** Die Sperre `locked_until` wird nur freigegeben, wenn der Task beendet ist. Sonst bleibt sie stehen, der Job steht als `failed` („läuft noch“), und `releaseLateJob` gibt sie bei seinem Ende frei, aber nur, wenn sie noch die eigene Beanspruchung ist (`lockedUntil` wird beim Beanspruchen mitgelesen).
- **`stillRunning`:** `claimDueJobs` überspringt solche Jobs in diesem Worker auch nach Ablauf der Sperre. Für andere Worker bleibt die Obergrenze die Sperrzeit (Zeitlimit + 30 s).
- **Abbruchsignal:** `closeOldSprints` prüft es vor jedem Abschluss.

### Idempotenz (`src/api/sprint-planning.ts`)

- `completeSprint` liefert jetzt `boolean`. Der Statuswechsel ist an `status = 'active' AND paused_at IS NULL` gebunden; war der Sprint schon abgeschlossen, gibt es ROLLBACK und `false`: kein zweiter Bericht, kein zweiter Git-Sync, keine zweite Push-Nachricht.
- `closeOldSprints` zählt und meldet nur echte Übergänge.

## Tests

- `src/runner/runner-budget-check.test.ts` (neu):
  - werfendes `budgetGate` vor dem ersten Schritt: kein Agent startet, Auftrag unterbrochen mit Ursache in `failure` und Schritt
  - Sprintbudget (Verbrauch der Sprint-Aufträge) nicht prüfbar: Sprint-Auftrag startet nicht
  - vorübergehender Fehler und Budget vor dem zweiten Versuch nicht prüfbar: kein zweiter Versuch, unterbrochen
- `src/runner/scheduler.test.ts`: langsamer Job, der den Folgedurchgang überspringt; Sperre bleibt bis zum Ende; Freigabe nur der eigenen Sperre.
- `src/api/sprint-complete.test.ts`: zweiter `completeSprint` ist wirkungslos.
- `close_old_sprints`: schon abgeschlossener Sprint ohne zweite Push-Nachricht; nach Abbruch kein weiterer Abschluss.

Ausgeführt wurden die Tests von der Dokumentation nicht erneut.

## Geänderte Dateien

- `src/runner/runner.ts`, `src/runner/runner-steps.ts`, `src/runner/runner-context.ts`
- `src/runner/scheduler.ts`, `src/runner/scheduler.test.ts`
- `src/runner/runner-budget-check.test.ts`
- `src/api/sprint-planning.ts`, `src/api/sprint-complete.test.ts`
- `docs/laufzeit.md` (Abschnitt Budget), `docs/wartungs-jobs.md` (Zeitlimit, Sprint-Abschluss)

## Worauf zu achten ist

- **Eine Datenbankstörung pausiert Aufträge 5 Minuten**, statt sie ungebremst laufen zu lassen. Das ist gewollt. Der Auftrag steht als „Geplant“ mit Hinweis in `failure`, nicht als Bug.
- **`completeSprint` hat einen neuen Rückgabetyp.** Aufrufer mit eigener Ersatzfunktion (`deps.completeSprint`) müssen `Promise<boolean>` liefern.
- **Ein nicht endender Job** belegt seine Sperre bis zum Prozessende des Tasks bzw. bis zu `Zeitlimit + 30 s` für andere Worker. Im Log steht eine Warnung.
- **`claimDueJobs` kürzt `locked_until` auf Millisekunden**, damit der Vergleich in `releaseLateJob` exakt trifft.
- Keine Schema-Änderung, keine Migration.

## Sprint 23 und Anfrage/TODO

- Zustand: Umsetzung abgeschlossen (Entwickler, bestanden), Dokumentation hier. Ergebnis der Prüfung durch Tester und Reviewer steht noch aus.
- Offen/TODO: Einzeldateien-Tests ließ der Wächter nicht zu; vollständiger Lauf mit `npm test` im Test-Gate prüfen.
