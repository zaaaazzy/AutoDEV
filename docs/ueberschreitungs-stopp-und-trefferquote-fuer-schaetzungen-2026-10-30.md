# Überschreitungs-Stopp und Trefferquote für Schätzungen

Auftrag 099e001e-45ef-4005-ad93-980165a79487 (Feature). Anlass: Abweichungen der Schätzung vom 14- bis 34-Fachen in beide Richtungen.

## Aufträge

### 099e001e: Überschreitungs-Stopp und Trefferquote

**Was wurde umgesetzt**

1. **Genauere Ist-Referenz des Auftragsautors** (`src/agent/estimation.ts`): `loadActualReference` vergleicht Kategorie, Art (`feature`/`bug`) und Anzahl betroffener Bereiche (1, 2–3, 4+; gezählt über `areaBucket`/`affectedFiles` aus `src/core/sprint-planner.ts`). Hat die engste Gruppe weniger als `MIN_REFERENCE_ORDERS` (5) Aufträge, gilt der Median der Kategorie (gleiche Art, ohne Bereichsfilter). `referenceSection` nennt Art und Bereichsgruppe im Prompt.
2. **Art der Idee:** Neue Spalte `ideation_items.kind` (`feature`/`bug`, Standard `feature`, `ADD COLUMN IF NOT EXISTS`, läuft auch auf bestehenden Datenbanken). Ideen ohne Art werden nur mit `feature`-Aufträgen verglichen. API (`src/api/ideation.ts`, `development.ts`) und Idee-Detailansicht im Frontend wurden ergänzt.
3. **Kalibrierung** (`src/core/estimate-calibration.ts`): Faktor je Herkunft bleibt der Median von Ist ÷ Schätzung (Fenster 20, ab 5 Messwerten, sonst 1). Neu: `estimateHit` (Treffer, wenn Stunden und Tokens zwischen 0,5 und 2,0 × kalibrierter Schätzung liegen, Grenzen zählen), `hitRate`, `estimateOverrun` (strikt über `OVERRUN_FACTOR` = 3; genau das Dreifache läuft weiter).
4. **Überschreitungs-Stopp** (`src/runner/estimate-overrun.ts`, Einbau in `src/runner/runner.ts`): Vor jedem weiteren Agent-Schritt (also nach dem vorigen) wird der Ist-Wert (Summe `duration_ms` und `tokens` aller Schritte aller Rollen, auch Tester, seit `budget_since`) mit dem Dreifachen der kalibrierten Schätzung verglichen. Bei Überschreitung von Stunden oder Tokens bekommt der Auftrag Status `blocked`, `failure` = „Aktion notwendig: Schätzung überschritten – Ist …, kalibrierte Schätzung …“ und eine „Aktion notwendig“-Aufgabe (`overrunActionTodo` in `action-todo.ts`). Die Prüfung läuft nach der Budget-Prüfung und zusätzlich zu ihr; `blockForBudget` bleibt unverändert.
5. **Ohne Schätzung keine Prüfung:** `rawEstimate` liefert `null`, wenn weder Stunden noch Tokens geschätzt sind; dann gibt es nicht einmal eine Abfrage.
6. **Fehler in der Prüfung sperren sicher:** `guardedOverrunGate` fängt Fehler ab. Der Agent startet dann nicht, der Auftrag gilt als unterbrochen (5 Minuten Pause wie bei der Budget-Prüfung), kein stilles Weiterlaufen.
7. **Freigabe:** „Erneut versuchen“ setzt `budget_since` neu. Die Messung beginnt damit von vorn und gilt gegen die dann aktuelle Schätzung; der Auftrag wird nicht automatisch gestartet. Ein von Hand gestarteter Einzel-Agent (`item.agentId`) gilt selbst als Freigabe und wird nicht geprüft.
8. **Statistik** (`src/api/stats.ts`, Frontend `features/stats`): Je Sprint die Spalte „Trefferquote“ (Prozent und „x von y“, „–“ ohne gemessene Aufträge). Außerdem werden Korrekturfaktor und Anzahl der Messwerte je Herkunft angezeigt (`calibrationSummary`).

**Geänderte Dateien**

- Backend: `src/agent/estimation.ts`, `src/agent/requirements.ts`, `src/api/development.ts`, `src/api/ideation.ts`, `src/api/stats.ts`, `src/core/estimate-calibration.ts`, `src/core/sprint-planner.ts`, `src/db/migrations.ts`
- Runner: `src/runner/estimate-overrun.ts` (neu), `runner.ts`, `runner-agent.ts`, `runner-context.ts`, `runner-selection.ts`, `runner-types.ts`, `action-todo.ts`
- Frontend: `frontend/src/app/core/models.ts`, `features/stats/stats.component.ts` und `.html`, `features/ideation/idea-detail.component.ts` und `.html`
- Tests: `src/runner/estimate-overrun.test.ts` (neu), `src/agent/estimation.test.ts`, `src/agent/requirements.test.ts`, `src/api/stats.test.ts`, `src/core/estimate-calibration.test.ts`, `src/runner/sprint-autopilot.test.ts`
- Doku: `docs/laufzeit.md`, `docs/workflows.md`, diese Datei

**Worauf zu achten ist**

- **Gemessen wird nach abgeschlossenen Schritten.** Ein einzelner langer Schritt kann die Grenze deutlich überschreiten, bevor er gestoppt wird.
- **Die Trefferquote nutzt die kalibrierte Schätzung**, deren Faktor aus denselben Daten stammt. Sie misst daher vor allem die Stabilität des Faktors. Bei wenigen Messwerten ist sie unsicher (Anzahl steht in der Anzeige).
- **Die Sperre hängt am Auftrag selbst** (`failure` und Aktion), nicht an einem fehlgeschlagenen Schritt. Die Analyse darf keinen `failed`-Schritt voraussetzen.
- **Nach der Freigabe** zählt der Verbrauch ab `budget_since` neu; sonst würde der Auftrag sofort wieder blockieren. Wer die Schätzung nicht erhöht, blockiert nach dem Dreifachen des neuen Verbrauchs erneut.
- Die Budget-Prüfung (Tag, Sprint, Auftrag, Rolle) blieb unverändert und wird zuerst ausgewertet.
- Keine rückwirkende Neuschätzung, kein Lernverfahren über den Median hinaus, keine neue Seite.
- Der Entwickler konnte weder Tests noch Typecheck ausführen (`node_modules` außerhalb des Arbeitsbereichs). Die Dokumentation hat sie ebenfalls nicht ausgeführt.

## Sprint

| Auftrag | Zustand | Details |
|---|---|---|
| 099e001e Überschreitungs-Stopp und Trefferquote | Umsetzung abgeschlossen (Entwickler, bestanden); Dokumentation hier | Tester gescheitert, weil die Umgebung nicht lief (nicht wegen Testfehlern); Reviewer steht aus; Tests nie ausgeführt |

## Anfrage/TODO

- **Tester-Lauf wiederholen:** Er scheiterte nur an der Umgebung, nicht an Testfehlern. Zuerst: `tsc: not found` bei `npm run typecheck` (Exit 127, Sandbox-Image „aideation-agent“) und `npx tsx` mit EACCES auf `/home/agent/.npm`. Im letzten Versuch stoppte das monatliche Ausgabenlimit der Organisation den Lauf (Limit durch die Administration anheben). Es gibt also noch kein Ergebnis zu Typen oder Tests. Die Tests sollen über `npm test` bzw. `npm run …` laufen.
- `npm run typecheck`, `npm run test:unit` und `npm run format:check` ausführen (Test-Gate). Einzelne Tests nur über `npm test`/`npm run …`, nicht mit `npx tsx` und ohne `--experimental-test-coverage`.
- Oberfläche prüfen: Spalte „Trefferquote“ und Faktoranzeige in der Statistik, Art-Auswahl in der Idee, „Aktion notwendig“-Karte mit Freigabe nur mit passender Berechtigung (`auth.can()` wie API-Regel).
- Oberflächentests (Tabellen, Dashboard) auf geänderte Texte prüfen.

## Technische Dokumentation

Ablauf: Agent-Schritt endet → Budget-Prüfung → Überschreitungsprüfung (`overrunGate`) → nächster Schritt oder `blockForOverrun`. Die Abläufe stehen auch in `docs/laufzeit.md` und `docs/workflows.md`.

| Baustein | Ort | Regel |
|---|---|---|
| Referenzgruppe | `loadActualReference` | Kategorie + Art; engste Gruppe (Bereichsanzahl) ab 5 Aufträgen, sonst Kategorie; letzte 200 erledigte Aufträge |
| Korrekturfaktor | `calibrationFrom` | Median Ist ÷ Schätzung, letzte 20 je Projekt, 1 unter 5 Messwerten |
| Treffer | `estimateHit` | 0,5 ≤ Ist/Schätzung ≤ 2,0 bei Stunden und Tokens; `null` = nicht gemessen |
| Überschreitung | `estimateOverrun` | Ist > 3 × kalibrierte Schätzung bei Stunden oder Tokens |
| Ist-Verbrauch | `loadOrderEffort` | Summe aller Schritte aller Rollen seit `budget_since` |
