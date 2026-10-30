# Unit-Tests der Agent-Module

Auftrag a51361d8 (Sprint 6): Die Module unter `src/agent` haben Unit-Tests, die Regressionen sofort sichtbar machen. Die Tests laufen ohne echte Agent-CLI, ohne Ollama und ohne Netzwerk.

## Was umgesetzt wurde

**Neue Testdateien** (vorher ohne Test):
`chat-progress.test.ts`, `loop-guard.test.ts`, `tool-paths.test.ts`, `ollama-client.test.ts`, `ollama-prompts.test.ts`, `ollama-tools.test.ts`. Jede exportierte Funktion hat mindestens einen Test.

**Erweiterte Testdateien** (Grenzwerte, Fehlerpfade, fehlende Zweige):
- `tool-permissions.test.ts`: jede Entscheidungsregel aus `tool-permissions.ts` mit eigenem Testfall, auch die Rolle `visionary`.
- `visionary.test.ts`: Fehlerpfade bei ungültigen oder leeren Modellantworten, Abbruch, Statusabfrage.
- `agent-guard.test.ts`, `model-routing.test.ts`, `estimation.test.ts`, `requirements.test.ts`.

Am Produktivcode in `src/agent` wurde nichts geändert. `src/runner`, `frontend` und `e2e` sind von diesem Auftrag nicht berührt.

## Ergebnis

- Typecheck grün; die 12 Testdateien des Auftrags: 165 Tests bestanden, 0 fehlgeschlagen.
- Zweigabdeckung laut Entwickler für alle Module in Scope mindestens 94 % (Messung mit `npm run test:coverage`).

## Worauf zu achten ist

- **Mocks:** `spawn` (Agent-CLI `claude`), HTTP an Ollama und Dateizugriffe werden gemockt. Dateien entstehen nur in temporären Verzeichnissen.
- **Reihenfolge in `requirements.test.ts`:** Der Shutdown-Test muss der letzte Test der Datei bleiben, weil `beginShutdown()` im Testprozess nicht zurückgenommen werden kann.
- **Coverage:** In der Agent-Umgebung blockiert der Wächter direkte `node`-/`npx`-Aufrufe mit `--experimental-test-coverage`. Die Messung läuft über `npm run test:coverage`. Gemeldet werden nur die festen Bereiche `backend`, `frontend`, `contracts`, `scripts`, `e2e`, `gesamt` und `auftrag` (`COVERAGE_AREA_KEYS` in `src/core/coverage-areas.ts`). Jeder gemeldete Bereich braucht einen Zeilen- und einen Zweigwert (Zahl von 0 bis 100) und mindestens einen Testfall. `null` ist nicht erlaubt; einen nicht messbaren Bereich lässt der Tester weg. Ein ungültiger `@@COVERAGE`-Block wird ganz verworfen (siehe `docs/coverage-feste-bereiche-2026-10-30.md`).
- **Bekannter Befund, nicht behoben:** `run_command` in `ollama-tools.ts` gibt `withProjectLock(...)` ohne `await` zurück. Fehler des Executors erreichen dadurch den `catch` nicht. Ein Test hält dieses Ist-Verhalten fest; wird der Fehler behoben, muss dieser Test angepasst werden. Dafür gehört ein eigener Bug angelegt.
- **Nicht Teil des Auftrags:** Integrations-/E2E-Tests sowie die Bugs „spawn claude ENOENT“ und „Auftrag blockiert ohne fehlgeschlagenen Schritt“.
