# Codeverständlichkeit: Umbau der grössten Stolpersteine (31.10.2026)

Ausgangspunkt war eine Bewertung der Verständlichkeit des Codes (Gesamtnote 6 von 10): lokal gut lesbar und
kommentiert, aber die eigenen Regeln aus `CLAUDE.md` (Status-Konstanten, Repositories, benannte Handler, Funktionen
unter 80 Zeilen) waren ausser im Auftrags-Bereich kaum umgesetzt. Dieser Auftrag setzt die vier Punkte mit dem grössten
Hebel um. Verhalten und Datenbank-Zugriffe sind unverändert; alle Unit-, Integrations- (PostgreSQL) und Frontend-Tests
laufen durch.

## 1 · Status-Werte als Konstanten

- Backend: Alle SQL-Vergleiche (`status = '…'`, `status IN (…)`, `CASE … THEN '…'`) und TypeScript-Vergleiche auf
  `development_items`, `bugs`, `sprints`, `ideation_items`, `agent_runs`, `agent_run_steps` und `test_runs` nutzen
  `DEVELOPMENT_STATUS`, `BUG_STATUS`, `SPRINT_STATUS`, `IDEATION_STATUS`, `AGENT_RUN_STATUS`, `AGENT_STEP_STATUS`
  und `TEST_RUN_STATUS` aus `src/core/status.ts` (53 Dateien). Listen wie `SPRINT_POOL_DEVELOPMENT_STATUSES`
  (`src/core/development-transitions.ts`, `src/core/sprint-rules.ts`) bauen auf den Konstanten auf; neue benannte
  Listen erklären ihren Zweck (`REDRAFTABLE_STATUSES`, `RETURNABLE_SQL`, `SPRINT_BOUND_STATUSES`, `SPRINT_IN_WORK`).
- Tabellen ohne eigene Konstanten (`test_requests`, `git_fix_requests`, `production_rollbacks`, `chat_messages`,
  `visionary_runs`, `acceptance_checks`) behalten ihre Literale; `src/db/schema.ts` und `migrations.ts` bleiben als
  eingefrorene Historie unverändert.
- Wächter: `src/core/status-literals.test.ts` schlägt fehl, sobald im Backend wieder `'in_progress'`, `'backlog'`,
  `'wontfix'`, `'drafting'` oder `'considering'` als Text steht (die einzigen Werte, die nur als Status vorkommen).
- Frontend: `frontend/src/app/core/models.ts` reicht die vier fachlichen Konstanten weiter. Vergleiche auf Aufträge,
  Bugs, Sprints und Ideen sowie die Statuslisten (Etiketten, Kanban-Reihenfolge, Bug-Formular, Ideen-Filter) nutzen
  sie; der Typ der Modelle (`DevelopmentStatus`, `BugStatus`, `SprintStatus`) prüft dabei, dass der Wert zur Tabelle
  passt. Offen: 69 Vergleiche in HTML-Templates (Konstanten wären dort nur über die Komponente erreichbar) und die
  `IdeaPhase` des Frontends (`'in_progress'` als Phase, nicht als Status).

## 2 · Worker-Hauptschleife (`src/runner/runner-cli.ts`, vorher `main` mit 488 Zeilen)

- `runner-cli.ts`: Start, Umgebung, Worker-ID, Sperre und Aufräumen des Vorgängers (`cleanUpPredecessor`), ein
  Zyklus ohne `--watch` (`runAllOnce`); `main` hat noch rund 70 Zeilen.
- `worker-loop.ts`: der Dauerbetrieb. Jeder Takt ist eine benannte Funktion mit eigener Konstante fürs Intervall:
  `startHeartbeat` (15 s: Lebenszeichen, verwaiste Läufe, Git-Lösungen, Rollbacks, Produktions-Rückkanal, Git-Abgleich,
  Favicons), `startAssistantLoop` (1,5 s: Tests, Schätzung, Autor, Sprint-Kommentar, Visionär, Chat, Analyse je
  Projekt), `startSetupLoop`, `startReviewLoop`, `startRoutineLoop`, `startRestartWatch`, `startFolderWatch`, dazu
  `runWorkLoop` mit `startDueProjects` (Plätze, Ordner-Sperre, längst Wartender zuerst).
- `WorkerTasks` ersetzt zehn einzeln gepflegte `*Active`-Sets und sechs Flags: `ProjectTasks` (höchstens eine Aufgabe
  je Projekt, Fehler einmal je Projekt im Log) und `SharedTask` (projektübergreifend, begrenzte Parallelität).
  `busy()` für den Neustart zählt damit auch laufende Schätzungen, die in der alten Handliste fehlten; `draining()`
  ist die Warteliste beim Beenden. Nebenwirkung: Fehler von Git-Lösungen, Rollbacks und GitHub-Brücke erscheinen jetzt
  einmal je Projekt statt bei jedem Takt.
- `worker-targets.ts` (Projektziele, Ordner-Meldungen, Lebenszeichen, `INSTALL_ROOT`) und `worker-log.ts`
  (`describeError`, `logOnce`, `forgetLogged`). Eine Variable (`chatTargets`), die in Closures vor ihrer Deklaration
  benutzt wurde, gibt es nicht mehr: Die Takte lesen `worker.targets`.
- Tests: `worker-loop.test.ts` (Aufgabenbegrenzung, Fehlermeldung einmal je Projekt, `busy()`), bestehende Tests
  umgestellt auf die neuen Module.

## 3 · Schritt-Ausführung (`src/runner/runner-steps.ts`, vorher `executeStep` mit 411 Zeilen)

- `step-invocation.ts`: der Agent-Aufruf. `watchCancel` (Abbruch aus der Oberfläche), `stepHooks` (Live-Ausgabe, PID,
  Sitzung), `attempt` (Abbruch wartet auf das echte Ende des Agents), `retryAfterTransientFailure` (zweiter Versuch nur
  mit geprüftem Budget), `invokeWithRetry` als Einstieg; Ergebnis ist eine `Invocation` mit `cancelled`, `budgetStop`,
  `budgetUnchecked` und `startedAt`.
- `step-evaluation.ts`: die Bewertung. `judgeAcceptance` (Tester), `judgeReview` (Reviewer), `refusedByRule`,
  `judgeConflicts`, `recordCoverage`, `collectHandoffs`, `appendChangedFiles`; dazu `conflictSection` und
  `remainingConflicts` (bisher in runner-steps).
- `runner-steps.ts`: `executeStep` ist der Ablauf in 25 Zeilen: `buildStepPrompt` → `invokeWithRetry` →
  `interruptionOutcome` (Nutzungslimit, defekter Arbeitscontainer, nicht prüfbares Budget, Worker-Ende, Ordner weg) →
  `judgeStep` → Abdeckung, Nachrichten, geänderte Dateien → `recordStep` → `settleOutcome` (Beobachter, Budget,
  Nachbesserung, Bug-Bericht, Commit). Reihenfolge aller Datenbank-Schreibzugriffe und Ereignisse ist gleich geblieben.

## 4 · Projekt-Routen (`src/api/projects.ts`, vorher `registerProjectRoutes` mit 410 Zeilen)

- `src/db/project-repository.ts`: alle SQL-Anweisungen der Projekt-Routen und die eine Spaltenliste `PROJECT_COLUMNS`
  (bisher zweimal im Handler, mit kleinen Abweichungen: die Antwort von `PATCH /projects/:slug` enthält deshalb neu auch
  `createdAt` und `faviconVersion`). `PRODUCTION_COLUMNS`, `GITHUB_COLUMNS` und `VISUAL_COLUMNS` liegen ebenfalls dort;
  `encryptProjectSecrets` wandert mit (Aufruf in `src/server.ts`).
- `src/api/project-input.ts`: `parseProjectPatch` prüft den Body je Einstellungsgruppe mit einer Funktion
  (`parseGitRemote`, `parseDatabaseUrl`, `parseDefinitions`, `parseTestCommands`, `parseReviewSettings`,
  `parseWorkingHours`, `parseFlags`, …) und liefert Spaltenzuweisungen oder den Fehlertext; die `$n`-Nummern vergibt
  erst `updateProject` im Repository. `parseProductionSettings` liegt jetzt hier.
- `projects.ts`: benannte Handler (`list`, `patch`, `create`, `remove`, `gitGraph`, `favicon`, `checkGithubAuth`),
  `registerProjectRoutes` verbindet nur Pfad, Rechte und Handler. Fehler laufen einheitlich über den zentralen
  JSON-Error-Handler (Express 5 fängt abgelehnte Promises), statt teils über `try/catch → next(error)`.

## Prüfung

`npm run lint`, `npm run format:check`, `npm run typecheck`, `npm run test:unit` gegen die lokale PostgreSQL
(Datenbank-Tests nicht übersprungen), `npm run build:ui`.

## Noch offen (aus der Bewertung)

- `src/runner/runner.ts` `runWorkItem` (274 Zeilen) und `src/runner/git-sync/sprint-sync.ts` `pushSprint` (184 Zeilen).
- Weitere `register*Routes` mit eingebettetem SQL (`sprints.ts`, `agents.ts`, `worker.ts`, `review-routes.ts`,
  `bugs.ts`, `auth.ts`) nach demselben Muster.
- Gegenseitige Importe `agent/` ↔ `runner/` und Importe aus `api/` in beiden; `core/` importiert aus `runner/` und
  `agent/` (`known-bugs.ts`, `sandbox.ts`).
- Frontend: `shared/` mit 76 flachen Dateien, API-Aufrufe in Komponenten statt in Services, Komponenten mit mehreren
  Verantwortungen (`agent-tasks`, `project-wizard`, `workflow-steps`), 289 Hex-Farben ausserhalb von `01-base.css`.
