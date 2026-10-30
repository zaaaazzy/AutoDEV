# Kalibrierte Schätzung mit Warnung und Fehlertrend

## Aufträge

### Auftrag ef5e57c7

Titel „Kalibrierte Schätzung mit Warnung und Fehlertrend“ (Agent „Entwickler“, danach Dokumentierer).

**Ergebnis:** Die Kalibrierung lernt feiner aus erledigten Aufträgen, der Auftragsautor sieht den Korrekturfaktor im Prompt, laufende Aufträge mit mehr als dem Dreifachen ihrer kalibrierten Schätzung fallen im Dashboard auf, und die Statistik zeigt den Schätzfehler je Sprint als Verlauf.

**Anforderung → Umsetzung**

- **Gruppen der Kalibrierung** (`src/core/estimate-calibration.ts`, Regeln in `src/core/estimate-overrun.ts`): Art (`feature` / `bug`, `kindOf`), Kategorie und Schrittklasse (`stepClassOf`, `STEP_CLASS_LIMITS`: bis 10, 11 bis 20, mehr als 20 Agent-Schritte über alle Läufe des Auftrags; 12 Schritte fallen also in die mittlere Klasse).
- **Stufenweiser Rückfall** (`segmentFactorFrom`): unter `MIN_CALIBRATION_SAMPLES` (5) Messwerten gilt Art und Kategorie, dann Art, dann alle Aufträge des Projekts, dann aller Projekte, dann 1. `scope` bzw. `tokenScope` nennen die gewählte Stufe.
- **Kein Speicherschritt:** Alles wird bei jedem Aufruf aus `development_items`, `agent_runs` und `agent_run_steps` abgeleitet. Es gibt keine neue Tabelle und keine neue Spalte. Ein erledigter Auftrag ändert den Faktor der nächsten Schätzung sofort. Es zählen nur Aufträge im Status erledigt; setzt man einen zurück, zählt er nicht mehr.
- **Prompt des Auftragsautors** (`src/agent/estimation.ts`, `src/agent/requirements.ts`): Der Median vergleichbarer Aufträge berücksichtigt jetzt Art und Schrittklasse (Rückfall: nur Kategorie). Neue Zeile „Korrekturfaktor …“ mit Faktor für Stunden und Tokens, Anzahl der Messwerte und gewählter Gruppe. Schätzungen der Herkunft `legacy` (Altbestand) fließen nicht in den Prompt ein (`AUTHOR_PROMPT_SOURCES`), zählen aber weiter für die Stundenkalibrierung des Altbestands. Gespeichert wird die Schätzung des Autors unverändert.
- **Laufwarnung** (`loadEstimateOverruns`, `exceedsEstimate`, `OVERRUN_FACTOR = 3`): Ein Auftrag im Status `in_progress` oder `blocked` mit strikt mehr als dem Dreifachen seiner kalibrierten Stunden oder Tokens wird als `overruns` in `GET …/stats` geliefert. Genau das Dreifache löst nicht aus (Toleranz gegen Gleitkomma-Rauschen). Verbrauch und Schritte zählen über alle Läufe, alle Rollen und alle Status, nicht nur `failed`. Ohne Schätzung, bei Schätzung 0 oder bei einem Fehler gibt es keine Warnung und keine Blockade (leere Liste, Fehler wird protokolliert).
- **Dashboard** (`frontend/src/app/features/dashboard/`): Panel „Schätzung überschritten“ oben in der Struktur „Besondere Aufmerksamkeit“, nur bei Warnungen sichtbar; reine Anzeige ohne Aktion, daher ohne `auth.can()`-Prüfung. Hilfslogik in `estimate-overruns.ts`.
- **Schätzfehler je Sprint** (`velocity[].hourError` / `tokenError`): Median von Ist ÷ Schätzung (roh, wie geschätzt) der erledigten, gemessenen Aufträge des Sprints. Sprints ohne solche Aufträge liefern `null`, nicht 0. Die Statistik zeigt den Verlauf über die letzten 8 Sprints, ältester zuerst (`estimate-trend.ts`), mit neutralem Leertext ohne Filterhinweis.

**Geänderte Dateien**

- Backend: `src/core/estimate-overrun.ts` (neu), `src/core/estimate-calibration.ts`, `src/core/estimate-calibration.test.ts`, `src/agent/estimation.ts`, `src/agent/requirements.ts`, `src/api/stats.ts`.
- Frontend: `frontend/src/app/core/models.ts`, `features/dashboard/dashboard.component.{ts,html}`, `features/dashboard/estimate-overruns.ts` und `.spec.ts` (neu), `features/stats/stats.component.{ts,html}`, `features/stats/estimate-trend.ts` und `.spec.ts` (neu).
- Doku: `docs/workflows.md` (Abschnitt Kalibrierung), diese Datei.

**Tests:** Der Entwickler hat `estimate-calibration.test.ts` erweitert und zwei Frontend-Specs ergänzt. Die Dokumentation hat die Tests nicht selbst ausgeführt; Ergebnis steht im Bericht von Tester und Entwickler.

**Worauf zu achten ist**

- Die Dreifach-Schwelle und die Schrittklassen sind je eine gemeinsame Konstante in `src/core/estimate-overrun.ts`; Änderungen nur dort.
- Die Warnung vergleicht mit der kalibrierten, nicht der rohen Schätzung. Ein Auftrag mit ohnehin hohem Herkunftsfaktor gilt so nicht als Ausreißer.
- Die Warnung ist nur Anzeige: keine Push-Nachricht, keine Sprint-Blockade, unabhängig von Budgets. `src/runner/budget.ts` (auch die 80-%-Warnung) ist unverändert.
- Der Prompt-Faktor ist ein Hinweis; die Schätzung wird nicht automatisch umgerechnet.
- Die 34-fachen Abweichungen aus der Idee stammen vermutlich vom Altbestand; das wurde nicht gegen Daten geprüft.
- Die Schätzfehler-Werte im Trend sind roh (Ist ÷ gespeicherte Schätzung), nicht kalibriert. Sie zeigen damit, wie gut die Schätzungen ohne Korrektur waren.

## Sprint

| Auftrag | Inhalt | Zustand |
| --- | --- | --- |
| ef5e57c7 | Kalibrierte Schätzung mit Warnung und Fehlertrend | Entwickler fertig (Bestanden), Dokumentation hier. Tester: nicht bestanden, aber nur wegen der Umgebung (siehe unten). Review/Merge offen |

## Anfrage / TODO

- **Tests sind noch nicht gelaufen.** Der Tester-Lauf scheiterte in der Sandbox: `npm run typecheck` fand `tsc` nicht (Exit 127, Image „aideation-agent“), und `npx tsx --test …` brach mit `EACCES` am root-eigenen npm-Cache ab. Das ist kein Testfehler im Code. Erneut ausführen: `npm_config_cache=/tmp/npm-cache npx tsx --test src/core/estimate-calibration.test.ts src/api/stats.test.ts src/agent/estimation.test.ts src/agent/requirements.test.ts frontend/src/app/features/dashboard/estimate-overruns.spec.ts frontend/src/app/features/stats/estimate-trend.spec.ts`, danach `npm run typecheck` mit installierten Abhängigkeiten.
- **Erneuter Versuch (30.10.2026 12:22):** Vorschlag der Analyse: Agent-Image neu bauen und einmal `npm ci` ins `node_modules`-Volume ausführen. Das ist eine Umgebungsänderung, kein Code-Fix am Auftrag; erst danach sind Typecheck und Tests aussagekräftig.
- Zusätzlich geänderte Dateien, die nicht zur Fachlogik gehören: `frontend/tsconfig.app.json`, `frontend/tsconfig.spec.json`, `src/api/stats.test.ts`, `test-results/ts-loader/{hook,register}.mjs`. Vor dem Merge prüfen, ob die tsconfig- und `test-results`-Änderungen gewollt sind (Testartefakte gehören nicht ins Repository).
- Tester: Akzeptanzkriterien prüfen (Bugfix-Faktor getrennt, 12 Schritte nicht in „bis 10“, Rückfall mit `scope`, genau 3× keine Warnung, Sprint ohne erledigte Aufträge ohne Wert). `estimate-calibration.test.ts` und `stats.test.ts` müssen grün bleiben.
- Oberflächentest `full-ui.check.ts` auf das neue Panel „Schätzung überschritten“ und den Schätzfehler-Verlauf (Desktop und Handy) prüfen.
- Mit echten Daten prüfen, ob die Segmentierung die 34-fachen Abweichungen tatsächlich erklärt.
- Später möglich: Push-Benachrichtigung bei Überschreitung (bewusst nicht Teil dieses Auftrags).

## Technische Dokumentation

- `docs/workflows.md`: Abschnitte „Kalibrierung“, „Gruppen-Kalibrierung“, „Laufwarnung“, „Schätzfehler je Sprint“.
- Ablauf: Auftrag erledigt → Gruppe aus Art, Kategorie, Schrittklasse → mindestens 5 Messwerte? ja: Gruppenfaktor, nein: gröbere Stufe → Prompt des Auftragsautors. Laufender Auftrag → Verbrauch > 3 × kalibrierte Schätzung → Eintrag in `overruns` → Dashboard.
- API: `GET …/stats` liefert zusätzlich `overruns` und je Sprint `hourError` / `tokenError`.

### Nachtrag: Testbefehle in der Docker-Sandbox (erneuter Versuch)

Der Tester scheiterte nicht am Code des Auftrags, sondern an der Sandbox: `tsc: not found` und `EACCES` unter `/home/agent/.npm`.

- `deploy/agent/Dockerfile`: Die globale Installation läuft als root mit `HOME=/home/agent`; ihr npm-Cache wird jetzt entfernt. Sonst gehört `/home/agent/.npm` root, und `npx`/`npm` im Container (ohne root) scheitern. **Image neu bauen** (`docker build -t aideation-agent -f deploy/agent/Dockerfile .` bzw. „AIdeation neu starten“).
- `src/core/sandbox.ts`: Das node_modules-Volume je Projekt wurde nie gefüllt. Vor jedem Lauf prüft `installModules` die Marke `.aideation-lock` (SHA-256 des `package-lock.json`) und führt bei Abweichung `npm ci --ignore-scripts` in einem Hilfscontainer aus: Benutzer des Agents, über den Egress-Proxy, eingebunden sind nur `package.json`, `package-lock.json` (lesend) und das Volume. Ein Fehler sperrt den Lauf nicht; die Ausgabe erhält einen Hinweis.
- `src/core/sandbox.ts` (`replaceLinkedModules`): Eigene Agent-Worktrees verlinken `node_modules` auf den Hauptordner. Im Container zeigt der Link auf einen Host-Pfad, und `npm ci` scheitert mit `ENOTDIR`. Der Link wird vor dem Lauf durch einen leeren Ordner ersetzt; das Ziel bleibt unberührt.
- `src/runner/agent-workspace.ts`: Im Notfallmodus ohne Sandbox wird ein leerer `node_modules`-Ordner wieder verlinkt.
