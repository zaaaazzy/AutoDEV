# Workflows im AIdeation

Ergänzt [agents-und-rechte.md](./agents-und-rechte.md) (Worker, Trigger, Rechte) um den **logischen Ablauf** der Workflows.

## 1. Überblick

```
Idee ──schätzen──► Idee ──ausarbeiten (Auftragsautor)──► Auftrag (Backlog)
                                                              │ Sprint zuordnen + Sprint starten
                                                              ▼
                                              Auftrag „Geplant“ (automatisch im aktiven Sprint)
                                                              │ Worker-Zyklus (30 s)
                                                              ▼
                      pre_task → while_task → after_task (Agents des Projekts)
                         │                                   │
                    Fehler: Auftrag „Blockiert“          Erfolg: Auftrag „Erledigt“
                         │                                   │
                  Bug-Bericht + Fix-Auftrag             Commit im Projektordner
                         │ Fix erfolgreich                     │
                  Ursprungsauftrag läuft erneut         Sprint abschließen ─► Sammel-Commit, Tag, Push
```

## 2. Ideen → Aufträge

1. **Idee anlegen:** Aufwand, Tokens, Nutzen und Kosten sind optional und lassen sich manuell eintragen.
2. **Auftragsautor** (`draftRequirements`): Idee mit Status `requested` → der Autor erhält Projektbeschreibung und Regeln (Einstellungen) und erzeugt in **einem Lauf** die Anforderung (Ziel, Akzeptanzkriterien, betroffene Dateien, Diagramme) und die Schätzung (Stunden, Tokens, Nutzen, Kosten). Manuell eingetragene Werte bleiben erhalten; die Schätzung wird in den Backlog-Auftrag übernommen.
3. **Bug-Wächter** (`assessRisks`): übernimmt die Anforderung des Autors, prüft sie gegen alle bisherigen Bugs (offene und behobene samt Lösung) und speichert die Risiken am Auftrag („was nicht wiederholt werden darf“). Beide Schritte laufen beim Ausarbeiten und werden bei der Abarbeitung nicht wiederholt.
4. Die Sprint-Zuordnung ist manuell oder läuft über die Sprintplanung (Abschnitt 3a). Hängende `drafting`-Ideen werden nach einer Frist zurückgesetzt.

## 3. Sprint-Lebenszyklus

| Status        | Bedeutung                                                                                                                                                                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Geplant       | Sprint angelegt, Aufträge zuordenbar; der Worker arbeitet nichts ab.                                                                                                                                                                                                                                 |
| Aktiv         | Maximal **ein** aktiver Sprint pro Projekt (DB-Constraint). Backlog-Aufträge des Sprints werden automatisch auf „Geplant“ gesetzt und abgearbeitet.                                                                                                                                                  |
| Abgeschlossen | Sprint-Bericht wird erzeugt; die Git-Sicherung wird automatisch eingereiht (DB-Trigger).                                                                                                                                                                                                             |
| Abgebrochen   | Aus „Geplant“ oder „Aktiv“ („Abbrechen“). Laufende Agents der Sprint-Aufträge werden beendet, offene Aufträge verlassen den Sprint mit Vermerk (Backlog, unter „Aktionen“ wieder einplanbar), Erledigtes bleibt beim Sprint. Keine Git-Sicherung, kein Merge. Lässt sich wieder planen oder löschen. |

## 3a. Sprintplanung und Autopilot

Pro Projekt einstellbar (Einstellungen → Sprintplanung, `projects.sprint_mode`):

| Modus                   | Verhalten                                                                                                                                                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manual` (Standard)     | Sprints werden selbst zusammengestellt; der Vorschlag erscheint nur auf Knopfdruck („Nächsten Sprint vorschlagen“).                                                                                                                                                   |
| `suggest` (vorschlagen) | Sprints zeigt immer die Karte „Vorschlag für Sprint N“; „Übernehmen“ bzw. „Übernehmen und starten“ per Klick.                                                                                                                                                         |
| `autopilot`             | Wie `suggest`, zusätzlich startet der Worker nach dem Go („Live schalten“) zu einem fertigen Sprint den nächsten Vorschlag selbst – nur innerhalb der Arbeitszeiten. Fertige Sprints schliesst er nur mit der Einstellung „Autopilot schaltet selbst live“ selbst ab. |

**Planer** (`src/core/sprint-planner.ts`, deterministisch, ohne Modell):

- Kandidaten: Aufträge `backlog`, `planned` und `blocked` ohne Sprint oder aus abgeschlossenen Sprints.
- Score = Prioritätsgewicht (hoch 3, mittel 2, niedrig 1) × (Nutzen + 1) / (Kosten + 1); +2 für Bugs, +1 für Folgeaufträge mit erledigtem Vorgänger, −1,5 für Aufträge, die blockiert waren oder aus einem Sprint genommen wurden.
- **Kapazität** = Median der Ist-Werte der letzten 3 abgeschlossenen Sprints: gemessene Laufzeit (Stunden) und Tokens aller Agent-Schritte erledigter Aufträge (`completedSprintUsage` in `src/api/usage.ts`). Ohne solche Sprints gilt `sprint_capacity_hours` (Standard 40 h); die Karte zeigt das als „Einstellung – noch keine Sprint-Historie“.
- Aufgefüllt wird nach Score, solange Stunden (Schätzung `effort_hours`, sonst 2 h) und Tokens (`token_estimate`) in die Kapazität passen; der erste Auftrag passt immer.
- Reihenfolge (`sprint_rank`): Ein Folgeauftrag kommt nur mit oder nach seinem Vorgänger in den Sprint und steht immer dahinter. Aufträge mit denselben betroffenen Dateien (Abschnitt „Technische Hinweise“ der Anforderung) stehen direkt hintereinander und laufen damit nacheinander unter der Projektsperre.
- „Aktion notwendig“-Aufträge (`blocked` mit `action_todo`) aus dem vorigen Sprint werden immer übernommen. Andere blockierte Aufträge werden normal bewertet.

**Vorschlagskarte:** Tabelle mit Begründung, Score, Stunden und Tokens je Auftrag; Summenzeile mit Stunden, Tokens und geschätzten Kosten. Die Kosten sind Tokens × Durchschnittspreis je Token aus den gemessenen Kosten (`tokenPriceUsd`, erst Projekt, sonst alle Projekte; ohne Messwerte Referenzpreis 5 $ je 1 Mio. Tokens). Ab- und Zuwählen aktualisiert die Summen sofort. „Übernehmen“ legt den Sprint an (Status geplant), ordnet die gewählten Aufträge zu und setzt `sprint_rank` in der angezeigten Reihenfolge; „Übernehmen und starten“ setzt ihn zusätzlich aktiv (nur, wenn kein anderer Sprint aktiv ist).

**KI-Kommentar (optional):** Der Knopf „🤖 KI-Kommentar“ reiht eine Anfrage ein (`sprint_proposal_comments`); der Worker lässt den Auftragsautor die aktuelle Auswahl in 3–5 Sätzen kommentieren (Sprintziel, Risiken). Reiner Text, höchstens 5 Sätze, ohne Einfluss auf die Auswahl. Beim Übernehmen wird er gelöscht und nicht am Sprint gespeichert.

**Roadmap:** „🗺 Roadmap“ berechnet die nächsten 3 Sprints nacheinander mit derselben Kapazität voraus. Eingeplante Aufträge gelten für die folgenden Sprints als erledigt (Folgeaufträge rücken nach) und erscheinen nicht erneut. Die Vorschau legt nichts an und ändert nichts (`GET …/sprints/roadmap`).

**Autopilot** (`src/runner/sprint-autopilot.ts`, am Anfang jedes Worker-Zyklus):

1. **Pause:** Ist die Git-Sicherung des zuletzt abgeschlossenen Sprints gescheitert (Merge-Konflikt, Test-Gate, Push), pausiert der Autopilot. Sprints zeigt die Meldung mit dem Git-Fehler, dazu kommt einmalig eine Push-Nachricht. Er startet keinen neuen Sprint, bis die Sicherung erneut erfolgreich läuft oder jemand mit der Rolle Planung „Autopilot freigeben“ klickt (`autopilot_released_sprint`). Der Merge- und Tag-Ablauf selbst bleibt unverändert.
2. **Abschluss läuft:** Solange die Sicherung `pending`/`running` ist, wartet er.
3. **Sprint fertig → Review:** Ein aktiver Sprint gilt als fertig (`sprintSettled`), sobald kein Auftrag mehr `backlog`, `planned`, `in_progress` oder `approval` (wartet auf Review-Freigabe) ist und alle verbleibenden `blocked`-Aufträge „Aktion notwendig“ haben. Blockierte ohne Aktion sind Fehler, die noch behoben werden, und halten den Sprint offen; ebenso wegen Budget blockierte (`budget_blocked`), die von selbst weiterlaufen. Abgelehnte Aufträge und Express-Anfragen aus dem Chat zählen nicht. Dann setzt `markSprintReady` `review_ready_at` und meldet einmal per Push „Sprint fertig“; der Autopilot wartet (`review`) und schliesst den Sprint nur mit „Autopilot schaltet selbst live“ (`autopilot_auto_live`, innerhalb der Arbeitszeiten, nicht bei pausiertem Sprint oder laufendem Auftrag) selbst ab. Abgeschlossen wird er mit dem Go („Live schalten“ in Sprints, Status `completed`) – das erzeugt den Bericht und reiht die Git-Sicherung ein (Test-Gate, Merge, Tag, Push). Optional schliesst der Wartungs-Job `close_old_sprints` fertige Sprints nach längerer Ruhe (Standard 14 Tage).
4. **Nächster Sprint:** Nur innerhalb der Arbeitszeiten (`autopilot_start`, `autopilot_end`, `autopilot_days`; Standard Mo–Fr 08:00–18:00, Ortszeit des Workers; „Bis“ vor „Von“ = über Mitternacht, gleiche Zeiten = ganztägig). Der Vorschlag wird übernommen und gestartet; die „Aktion notwendig“-Aufträge wandern mit. Enthält der Vorschlag nur solche Aufträge, startet kein Sprint.

**Grenzen:**

- **Budget:** Der Autopilot selbst prüft kein Budget; die Läufe, die er anstößt, halten aber die Budget-Limits ein (Abschnitt 4, „Budget“). Eine eigene Prüfung im Autopiloten gehört in `autopilotGuard` (`src/api/sprint-planning.ts`, eigener Auftrag).
- Die Kapazität vergleicht gemessene Agent-Laufzeit mit geschätzten Stunden der Kandidaten. Bei wenig Historie ist der Median ungenau. Sprints ohne gemessene Laufzeit (z. B. von Hand erledigt) zählen nicht als Historie.
- Die Roadmap rechnet mit der heutigen Kapazität und nimmt an, dass alle eingeplanten Aufträge erledigt werden.
- Bereits geplante, noch nicht gestartete Sprints und ihre Aufträge fliessen nicht in Vorschlag und Roadmap ein.

## 4. Abarbeitung eines Auftrags (`runWorkItem`)

- **Auswahl:** Status `planned` und (Sprint aktiv **oder** fester Agent **oder** `auto_run`). Reihenfolge: Priorität hoch → niedrig, dann Alter. Bis zu 3 Aufträge pro Durchgang; Entwickler und Tester arbeiten aber nie gleichzeitig an zwei Aufträgen (siehe unten). Vor dem Start wird jeder ausgewählte Auftrag erneut geprüft (noch `planned`, Sprint aktiv und nicht pausiert); wurde er inzwischen abgelehnt, zurückgestellt oder aus dem Sprint genommen, wird er übersprungen. Scheitert ein Auftrag unerwartet, laufen die übrigen weiter.
- **Hängende Aufträge:** Scheitert der Abschluss eines Auftrags (z. B. Datenbank kurz weg) oder stirbt der Worker dazwischen, wird ein Auftrag „In Arbeit“ ohne laufenden Lauf blockiert (Hinweis „Abschluss unterbrochen“, kein Bug) – am Anfang jedes Durchgangs und beim Worker-Start.
- **Sperre:** Pro Auftrag nur ein Lauf (`agent_runs` mit Status `running` ist eindeutig); Läufe älter als 3 h gelten als fehlgeschlagen.
- **Agents:** Aktivierte Agents laufen nach Phase (`pre_task`, `while_task`, `after_task`) und Position. Der erste fehlgeschlagene Schritt beendet den Lauf.
- **Informationsfluss:** Entwickler erhalten Anforderung und Risiken; jeder Agent bekommt die Ergebnisse der vorherigen Agents (Entwickler: Dateiliste → Tester → Dokumentierer → Handbücher).
- **Nach jedem Schritt:** Dokumentierer → Auftragsdoku, Handbuch-Autoren → Handbücher, Entwickler bei Bug-Aufträgen → Fix-Notiz am Bug.
- **Abbruch:** Der Nutzer kann einen Lauf abbrechen (Status Blockiert, ohne Bug-Bericht – auch nicht nachträglich über `backfillFailures`). Beim Herunterfahren des Workers wird der Auftrag zurück auf „Geplant“ gesetzt und läuft beim nächsten Start weiter.
- **Sofortstart:** Wird ein Auftrag eingeplant (neu, „Erneut versuchen“, Bugfix, Sprint gestartet), meldet die Datenbank das per `NOTIFY devlog_work`; der Worker startet den nächsten Durchgang sofort statt nach bis zu 30 s. Ein frei werdender Platz weckt ihn ebenfalls. Das Intervall bleibt als Absicherung.
- **Kurze Ausfälle:** Scheitert ein Schritt vorübergehend (Modell nicht erreichbar, überlastet, Rate-Limit, Verbindung abgebrochen, Zeitlimit), wird er nach 30 s einmal wiederholt. Erst wenn auch das scheitert, gilt der Schritt als fehlgeschlagen. Im Verlauf steht „Vorübergehender Fehler – neuer Versuch“.
- **Budget:** Unter Einstellungen → Budget lassen sich je Projekt Limits für Tag, Sprint und Auftrag setzen (Tokens und/oder USD, Tabelle `budgets`; leer = unbegrenzt, ohne Limit keine Prüfung). Verbrauch = `agent_run_steps` + `agent_usage` im Zeitraum (Tag ab Mitternacht, Sprint ab Sprintbeginn, Auftrag seit dem letzten „Erneut versuchen“, `budget_since`); Ollama zählt mit 0 USD, aber mit seinen Tokens. Vor jedem Agent-Schritt (`budgetGate`, `src/runner/budget.ts`) und vor jedem Lauf von Chat, Auftragsautor, Visionär usw. (`runAuthorAgent`) wird geprüft:
  - **ab 80 %:** genau eine Push-Warnung je Projekt, Zeitraum und Periode (gemerkt in `budget_warnings`);
  - **ab 100 %:** kein neuer Schritt; ein laufender Schritt endet regulär (das Limit kann um einen Schritt überschritten werden). Der Auftrag wird `blocked` mit „Aktion notwendig: Budget erreicht: erhöhen oder warten (…)“ – ohne Bug und ohne Bugfix; `budget_blocked` merkt den Zeitraum. Ist das Tages- oder Sprintbudget vor dem nächsten Auftrag erreicht – vor dem Durchgang oder mitten darin –, wartet genau ein Auftrag sichtbar, die übrigen bleiben eingeplant und starten keinen Lauf.
  - **Freigabe:** Zu Beginn jedes Durchgangs und nach dem Speichern der Limits (`releaseBudgetBlocks`) laufen Aufträge weiter, deren Zeitraum wieder Luft hat – das Tageslimit am Folgetag, sonst nach Erhöhen oder Entfernen des Limits; die Aktion verschwindet. „Erneut versuchen“ gibt einem Auftrag weiterhin ein neues Auftragsbudget.
- **Modell-Routing:** Regeln je Projekt (`routing_rules`, Reihenfolge = Priorität; ohne eigene Regeln die Standardregeln) wählen je Schritt die Stufe „lokal“ (Ollama-Modell) oder „stark“ (CLI-Befehl, z. B. Claude): `docs` → lokal, Schätzung < 1 h → lokal, `backend` und Schätzung > 4 h → stark, `retry_count ≥ 1` → eine Stufe höher, Budget > 80 % → eine Stufe tiefer. Die erste Regel mit fester Stufe bestimmt die Grundstufe, danach verschieben alle zutreffenden „höher/tiefer“-Regeln sie in ihrer Reihenfolge – bei zwei Stufen gewinnt also die letzte zutreffende Verschiebung (Budget-Bremse vor Retry-Eskalation). Ist für die Stufe kein Modell konfiguriert, bleibt die Modellwahl je Rolle; der Tester wird nie umgeleitet. Jeder Schritt speichert `model` und `routing_rule`; das Lauf-Detail zeigt z. B. „Modell: qwen3.5:9b (Regel: docs → lokal)“ (`src/agent/model-routing.ts`).
- **Zeitleiste:** Die Detailansicht zeigt oben in einem Satz, worauf der Auftrag gerade wartet (z. B. „Wartet auf die Problemanalyse“, „Wartet auf deine Antwort“, „Wartet auf den Start des Sprints“), und aufklappbar, wann welcher Agent lief, Statuswechsel, Analyse, Rückfragen und Bugfix (`GET /api/development/:id/timeline`; Statuswechsel speichert ein Trigger in `development_events`).
- **Einzelner Agent (Play-Knopf):** Läuft nur dieser Agent; danach wird der frühere Status wiederhergestellt. Es gibt dabei **keinen** Auftrags-Commit und keine automatische Wiederaufnahme.
- **Visuelle Abnahme (`visual_tester`, nach dem Tester):** Nur bei Kategorie Frontend oder Fullstack und gesetzter Vorschau-Adresse (Einstellungen → Visuelle Prüfung), sonst ohne Fehler übersprungen. Playwright (Chromium, Profile „Desktop Chrome“ und „Pixel 7“ wie in `e2e/playwright.config.ts`) nimmt jede konfigurierte Seite auf; der Vergleich läuft gegen die zuletzt gespeicherte Aufnahme derselben Seite und desselben Geräts (kein zweiter Checkout) mit `pixelmatch`, solange es nicht installiert ist mit einem eingebauten Vergleich nach demselben Farbabstand. Masken (CSS-Selektoren) und Passwortfelder werden vor der Aufnahme abgedeckt. Geprüft werden Überbreite auf dem Handy (dieselbe Messung wie `?layoutcheck`, `src/core/layout-measure.ts`), Konsolenfehler, Ressourcen mit HTTP-Fehler oder fehlende Bilder, leere Seiten und abgeschnittene Texte (nur zur Ansicht). Die Befunde stehen als `@@CHECK`-Zeilen in der Ausgabe und als Prüfpunkte „Visuelle Prüfung“ in der Abnahme; manuelle Punkte wie „auf dem Handy prüfen“ hakt der Schritt ab, wenn alle Handy-Prüfungen bestanden sind. Optional beurteilt ein Bildmodell (Befehl des Agents, z. B. Claude-CLI, sonst ein Ollama-Bildmodell) jedes Akzeptanzkriterium. Der Schritt blockiert den Auftrag nie: Nach 3 Minuten oder bei technischen Fehlern erscheint „visuelle Prüfung nicht möglich“. Test-Logins stammen nur aus der `.env.example` des Projekts und erscheinen nie in Bildern, Logs oder Prüftexten. Im Auftrag zeigt der Reiter „Ansicht“ Vorher, Nachher und Diff je Gerät; „Optisch freigeben“ speichert Person und Zeitpunkt. Chromium prüft und installiert der Einrichtungsassistent (`npx --no-install playwright install chromium`).

## 4a. Workflow (Agents → Workflow)

Unter „Agents“ legt die aufklappbare Karte „Workflow“ fest, wann welcher Agent läuft. Gespeichert sind Einsätze in
`workflow_steps` (Phase, Position, Agent, eigene Anweisung, aktiv). Derselbe Agent kann mehrfach vorkommen, z. B.
der Tester einmal „Danach“ für die API und einmal für die Oberfläche; die Anweisung des Einsatzes kommt zusätzlich
zur Anweisung des Agents in den Prompt und hat Vorrang. „+ Agent“ fügt einen bestehenden oder neuen Agent an das
Ende einer Phase, ↑↓ ordnet, „Pausieren“ nimmt einen Einsatz aus dem Ablauf, „Entfernen“ löscht nur den Einsatz.
Projekte ohne Schritte übernehmen beim ersten Öffnen ihren bisherigen Ablauf (Phase und Position am Agent); bis
dahin gilt dieser auch im Worker. API: `GET /api/projects/:slug/workflow`, `POST …/workflow/steps`,
`POST …/workflow/order`, `PATCH|DELETE /api/workflow-steps/:id` (Recht „Agents verwalten“).

| Zeitpunkt         | Phase         | Wann                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vor dem Sprint    | `pre_sprint`  | einmal, wenn ein Sprint aktiv wird, bevor sein erster Auftrag startet; nur lesend (Rolle `pre_sprint` in `READ_ONLY_ROLES`). Das Ergebnis steht in `sprints.pre_sprint_notes` und steht in jeder Agent-Anweisung der Aufträge dieses Sprints. Scheitert ein Agent, wird die Phase im nächsten Zyklus wiederholt (höchstens 3 Versuche, danach starten die Aufträge ohne sie); bei erreichtem Budget wird sie nachgeholt. Fehlermeldungen werden nie Sprint-Hinweis. |
| Vor dem Auftrag   | `pre_task`    | für jeden Auftrag, vor der Umsetzung                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Während           | `while_task`  | Umsetzung                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Danach            | `after_task`  | Tests, Review, Doku                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Bei abgelehnt     | `on_rejected` | am Ende eines gescheiterten Auftrags (nicht bei Unterbrechung oder erreichtem Budget)                                                                                                                                                                                                                                                                                                                                                                               |
| Bei abgeschlossen | `on_done`     | am Ende eines erfolgreichen Auftrags                                                                                                                                                                                                                                                                                                                                                                                                                                |

„Bei abgelehnt/abgeschlossen“ laufen noch vor dem Abschluss des Auftrags (ihre Änderungen landen im Commit), ändern
aber sein Ergebnis nicht: kein Bug, keine Abnahme, kein Statuswechsel.

**Nachrichten zwischen Agents:** Ein Agent schreibt `@@NACHRICHT: …` (an den nächsten Agent) oder
`@@NACHRICHT an <Name>: …`. Ist beim Absender „Nachricht geht an“ (`agents.handoff_to`) gesetzt, geht eine Nachricht
ohne Namen dorthin. Der Empfänger sieht sie unter „Nachrichten an dich“; gespeichert sind sie in
`agent_run_steps.handoffs`. Implementierung: `src/core/workflow-phases.ts`, `src/runner/pre-sprint.ts`.

## 5. Fehlerbehandlung und Auto-Bugfix

0. **Nachbesserung im selben Lauf:** Sind die Tests rot oder lehnt der Reviewer ab, geht der Auftrag zuerst einmal direkt zurück an den Entwickler – mit der Ausgabe von Tester bzw. Reviewer als Rückmeldung. Danach laufen Entwickler, Tester und Reviewer erneut. Erst wenn auch dieser Versuch scheitert, greift der folgende Ablauf. Die erste Rückmeldung bleibt als fehlgeschlagener Schritt im Lauf sichtbar („Zurück an den Entwickler zur Nachbesserung“). Bei einem einzelnen Agent (Play-Knopf) gibt es keine Nachbesserung.
1. Ein Schritt scheitert → Auftrag wird **Blockiert**, der Fehler am Auftrag gespeichert, ein **Bug-Bericht** angelegt. Das gilt in allen Phasen, also auch für Tester und Reviewer in `after_task`; nur Fehler der Doku-Agents (Dokumentierer, Handbuch-Autoren) blockieren den Auftrag ohne Bug.
   Ausnahme: Scheitert der Agent selbst (Zeitlimit, Schleife, Schrittlimit, keine Dateien geändert, Modell nicht erreichbar, Befehl nicht gefunden), entsteht **kein** Bug und kein Bug-Auftrag – der Auftrag bleibt blockiert und die Problemanalyse wird angefordert. Meldet die Claude-CLI ihr Nutzungslimit („You've hit your session limit · resets …“), gilt das als Unterbrechung: der Auftrag bleibt geplant und startet erst nach der gemeldeten Reset-Zeit wieder (`retry_after`).
2. Danach prüft die Problemanalyse (Rolle `analyst`, nur lesend) den Fehler. Erst wenn sie einen **Code-Fehler bestätigt** und `auto_bugfix` am Projekt aktiv ist (Standard), entsteht **einmalig** ein Bug-Auftrag (hohe Priorität, `auto_run`, auch ohne Sprint). Findet sie keinen Code-Fehler, bleibt der Auftrag mit „Aktion notwendig“ und ihrem Vermerk blockiert.
3. Ist der Bug-Auftrag erfolgreich, wird der Ursprungsauftrag erneut geplant (`auto_run`). **Höchstens 2 automatische Wiederholungen** (`retry_count`).

4. Scheitert ein Bug-Auftrag selbst, entsteht kein weiterer Bug (keine Endlosschleife); stattdessen wird eine Problemanalyse durch den Assistenten angefordert (nur lesend, Rolle `analyst`).
5. `backfillFailures` holt Bug-Berichte für ältere blockierte Aufträge nach.

**Wiederholung:** Ein blockierter Auftrag lässt sich in der Auftragsansicht und im Sprint („Erneut versuchen“) neu starten. Vorher fragt ein Bestätigungsdialog nach; ein optionaler Kommentar wird mit Datum unter „Hinweis zum erneuten Versuch“ an die Beschreibung gehängt und geht so an die Agents. Nach einem fehlgeschlagenen Lauf laufen nur der fehlgeschlagene Agent und die folgenden erneut; vorher erfolgreiche Agents werden übersprungen, ihre Ausgabe geht weiter an die Nachfolger.

**Rückfragen bei Chat-Aufträgen:** Braucht der Assistent bei einem Express-Auftrag aus dem Chat eine Antwort, zeigt der Auftrag (Liste und Detailansicht) die offene Frage samt Antwortoptionen. Die Antwort lässt sich direkt dort geben; sie wird als Antwort auf die Frage in den Chat gestellt (`GET /api/development/:id/question`, danach `POST …/chat` mit `replyTo`).

**Bestätigung mit Kommentar:** „Erneut versuchen“, „Sprintvorschlag übernehmen“ und alle Schnellaktionen des Assistenten (Aktionen, Tests, Visionär, AIdeation neu starten) öffnen zuerst ein eigenes Modal. Der optionale Kommentar wird mitgegeben: beim Sprintvorschlag als Sprintziel, bei Aktionen als „Hinweis dazu“ im Auftrag an den Assistenten, beim Visionär als Fokus, bei Testläufen und Neustarts gespeichert.

**Rückfrage per Push:** Die Push-Nachricht einer Rückfrage zu einem Auftrag öffnet direkt diesen Auftrag im richtigen Projekt und setzt den Cursor ins Antwortfeld (`#development/<id>?project=<slug>&answer=1`).

**Behoben und dokumentiert:** Schließt der Bug-Auftrag erfolgreich ab, setzt ein DB-Trigger den Bug auf „Behoben“. Die Lösung (Ausgabe des Entwicklers) steht am Bug (`fix_notes`) und wird allen späteren Agents als „bekannte Bugs mit Lösung“ mitgegeben. Der Bug-Fix lässt sich per Klick am Bug, am Auftrag oder im Sprint starten.

## 6. Git im Sprint

| Zeitpunkt                                         | Aktion                                                                                                                                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vor einem Sprint-Auftrag                          | Wechsel auf den Sprint-Branch `sprint/<name>` (bei Bedarf von `main` angelegt).                                                                                                               |
| Erster Agent, der Dateien ändert                  | Eigener **Auftrags-Branch** `auftrag/<id>-<titel>`, abgezweigt vom Sprint-Branch (sonst vom aktuellen Branch). Bei einem erneuten Versuch wird er fortgesetzt und der Basis-Stand eingemergt. |
| Auftrag erfolgreich (mit Auftrags-Branch)         | Commit auf dem Auftrags-Branch, Merge (`--no-ff`) in den Sprint-/Basis-Branch, Branch wird gelöscht. Scheitert der Merge, bleibt der Auftrag blockiert mit Meldung.                           |
| Auftrag fehlgeschlagen (mit Auftrags-Branch)      | Zwischenstand als WIP-Commit auf dem Auftrags-Branch, Rückkehr zur Basis; der nächste Versuch setzt dort fort.                                                                                |
| Auftrag im Sprint **erfolgreich**                 | Lokaler Commit auf dem Sprint-Branch, Conventional Commits: `feat(<Sprint>): <Titel>`, Bug-Aufträge `fix(...)`. Kein Push. Ohne Änderungen kein Commit.                                       |
| Auftrag **fehlgeschlagen**                        | Die vom Auftrag geschriebenen Dateien werden als Stash (`devlog-wip …`) geparkt und landen nicht im nächsten Commit; beim erneuten Versuch werden sie wiederhergestellt.                      |
| Sprint-Sicherung (Pfeil-hoch neben GitHub-Symbol) | Reständerungen committen, **Test-Gate** (Projekttests), nur bei grünen Tests Push des Sprint-Branches.                                                                                        |
| Sprint abgeschlossen                              | Zusätzlich Merge des Sprint-Branches nach `main` (`--no-ff`), erneutes Test-Gate, Push von `main` und Tag `sprint-<name>-<id>`. Bei Merge-Konflikten Abbruch mit Meldung.                     |
| Git Download (Pfeil-runter)                       | `git pull --ff-only origin <Branch>` im Projektordner; lokale Änderungen oder abweichende Historie brechen mit Meldung am Sprint ab.                                                          |

**AIdeation entwickelt sich selbst:** Arbeiten die Agents in einem eigenen Worktree, ist `main` im Arbeitsordner der Menschen ausgecheckt und wird dort normalerweise nicht angefasst. Mit der Projekteinstellung „Nach dem Sprint-Abschluss AIdeation neu starten“ (`restart_after_sprint`) übernimmt der Worker den abgeschlossenen Sprint dort selbst – aber nur, wenn im Ordner keine Änderungen offen sind und `main` ausgecheckt ist. Danach läuft das Test-Gate in diesem Ordner; ist es rot, wird der Merge mit `git reset --keep ORIG_HEAD` zurückgenommen. Klappt alles, wird `main` gepusht (falls ein Repository hinterlegt ist) und „AIdeation neu starten“ angefordert. Ab der Anforderung startet der Worker nichts Neues mehr (Drain: keine Aufträge, Chats, Tests, Jobs oder Git-Sicherungen) und bringt Laufendes zu Ende; ein Test-Gate, das der Neustart trotzdem beendet, wird wieder eingereiht statt als gescheitert zu gelten. Ein unterbrochener Auftrag (Neustart, Nutzungslimit, Sprint-Pause) sichert seinen Stand als WIP-Commit auf dem Auftrags-Branch und gibt den Arbeitsordner frei.

### GitHub-Brücke (`github_mode`)

Projekteinstellung „GitHub-Brücke“ mit den Modi `aus` (Standard), `issues` und `issues+pr`; nur mit einem `git_remote` auf github.com. Dev Log speichert kein Token, sondern nutzt die Anmeldung der GitHub CLI des Worker-Benutzers (`gh auth login`). Der Worker prüft sie mit `gh auth status` und zeigt das Ergebnis in den Einstellungen; ohne Anmeldung bleibt der Modus wirkungslos und Git-Sicherung, Merge und Tag laufen wie oben. Im Modus `aus` ruft die Brücke `gh` nicht auf (das bestehende Warten auf die CI beim direkten Merge bleibt unverändert).

- **Issue-Import** (`src/runner/github-sync.ts`, alle 5 Minuten im Worker-Takt): offene Issues mit Label `bug` bzw. `idea` werden zu Bug bzw. Idee mit `source='github'` und `external_ref='owner/repo#N'`; nach dem ersten Lauf nur die seit dem letzten Lauf geänderten (`--search updated:>=…`). Der eindeutige Index `(project_slug, external_ref)` verhindert Doppelimporte, ein Issue mit beiden Labels wird zum Bug. Bilder werden nie geladen, nur als Link übernommen. Der Issue-Text steht zwischen Markierungen für fremden Text; Auftragsautor, Schätzung und Entwickler bekommen dann einen Hinweis gegen Prompt-Injection.
- **Rückmeldung:** Wechselt der Stand eines importierten Eintrags (ausgearbeitet, im Sprint, blockiert, erledigt), schreibt Dev Log genau einen gebündelten Kommentar ins Issue und vermerkt den Stand in `github_synced_status`. Bei „erledigt“ wird das Issue mit Verweis auf Commit (`development_items.git_commit`) bzw. Sprint-Tag geschlossen.
- **PR-Modus** (`issues+pr`): Beim Sprint-Abschluss pusht `pushSprint` den Sprint-Branch und öffnet statt des direkten Merges `gh pr create` (Titel `Sprint: <Name>`, Text = Sprintbericht per `--body-file`). Der Sprint steht dann auf `review` mit `pr_url` und `ci_status`. `pollSprintReviews` fragt alle 2 Minuten `gh pr checks` ab: grün (und bei „Freigabe erforderlich“ nach Approve) → `gh pr merge --merge`, danach Tag auf dem gemergten `main` und Fast-Forward des lokalen `main`; rot → höchstens ein Bug je CI-Lauf mit gekürztem, maskiertem Auszug aus `gh run view --log-failed`. Ein von Hand gemergter Pull Request wird nur noch getaggt; ein ohne Merge geschlossener beendet den Sprint mit gescheiterter Git-Sicherung. Solange ein Sprint im Review ist, startet der Autopilot keinen neuen Sprint, und sein Status lässt sich nicht von Hand ändern (die API antwortet mit 409). Abschließen kann ihn nur der Worker nach dem Merge.
- **Sicherheit:** Alle `gh`-Aufrufe laufen über `runCommand` ohne Shell, nur mit den Unterbefehlen aus `GH_COMMANDS` (`src/runner/github.ts`), mit `GH_PROMPT_DISABLED=1`, validierten Argumenten (Repository, Issue-Nummer, Branch, PR-Link, Lauf-ID) und maskierter Ausgabe. Agents bleibt `gh` gesperrt. Bei einem Rate-Limit pausiert die Brücke des Projekts bis zum nächsten Intervall. Die Hoster-Logik steht hinter `HosterAdapter` (`src/runner/hoster.ts`), damit später ein zweiter Adapter folgen kann.

Ausgeschlossen bleiben `.env`, `.dev-log/`, `.dev-log-backups/` sowie typische Schlüsseldateien (`*.pem`, `*.key`, `id_rsa*`, `.netrc`, `credentials.json` …) per `.git/info/exclude`. Zusätzlich prüft jeder automatische Commit die hinzugefügten Zeilen auf Zugangsdaten (private Schlüssel, GitHub-, AWS-, Anthropic-, OpenAI-, Slack- und Google-Tokens); betroffene Dateien bleiben uncommittet im Arbeitsverzeichnis und werden im Log gemeldet. Alle Git-Aktionen laufen unter der Projektsperre, damit sie sich nicht mit Agent-Befehlen überschneiden.

## 7. Nach dem Zyklus

Repo-Dokumentation spiegeln (`syncRepoDocs`), Sprint-Bericht für den aktiven Sprint aktualisieren, danach Git-Sicherung ausstehender Sprints.

## 8. Bewertung der Logik (Stand der Prüfung)

**Konsistent:** keine Doppelläufe, keine Endlosschleifen beim Auto-Bugfix, Unterbrechungen sind wiederaufnehmbar, Sprint-Abschluss löst die Sicherung zuverlässig aus.

**Bewusste Grenzen:**

- Aufträge laufen sequenziell pro Projekt; mehrere Projekte parallel (`maxConcurrentAgents`).
- Nach erfolgreichem Play-Lauf eines Bug-Auftrags wird der Ursprungsauftrag nicht automatisch fortgesetzt.
- Auftrags-Commits werden nicht gepusht; erst die Sprint-Sicherung pusht (nur bei grünen Tests).

## Parallelität

- **Auftragsautor:** Läuft in eigener Schleife des Workers und schreibt Anforderungen, während andere Aufträge entwickelt werden.
- **Schnellschätzung:** Läuft ebenfalls unabhängig.
- **Aufträge:** Der Worker nimmt bis zu 3 geplante Aufträge pro Durchgang (`--limit 3`). Ab dem ersten Agent, der Dateien ändert (Phase „Umsetzung“ sowie Entwickler und Tester in jeder Phase), hält ein Auftrag die Projektsperre bis einschließlich Auftrags-Commit. So testet und committet der Tester nie halbfertige Änderungen eines anderen Auftrags. Vorbereitung und Nachbereitung (Dokumentierer, Handbuch-Autoren) laufen parallel zur Umsetzung eines anderen Auftrags.
- Grenze: Der Git-Commit eines Auftrags kann Änderungen enthalten, die ein parallel laufender Auftrag schon im Arbeitsverzeichnis hat.

## Deploy nach Aufträgen

Pro Projekt lassen sich in den Einstellungen Deploy-Befehle hinterlegen (z. B. `docker compose up -d --build`). Der Worker führt sie im Projektordner aus, sobald ein Zyklus mindestens einen erfolgreichen Auftrag hatte. So laufen Container mit dem Code der Agents. Das Ergebnis steht in den Einstellungen.

## Sprint-Ablauf: vom Start bis Live

1. **Sprint starten:** Aufträge laufen auf dem Sprint-Branch `sprint/<name>`.
2. **Ein Auftrag nach dem anderen:** Jeder Auftrag zweigt auf seinen eigenen Branch `auftrag/<id>-…` ab; je Projekt
   läuft immer nur ein Auftrag.
3. **Commit nach jedem Agent:** Was ein Agent ändert, wird sofort committet („Entwickler: Titel“, bei einem
   gescheiterten Schritt „wip(Tester): Titel“). Bricht etwas ab, setzt der Agent dort und in seiner Sitzung fort.
4. **Auftrag fertig:** Der Auftrags-Branch wird in den Sprint-Branch gemergt.
5. **Vorschau:** In der Sprint-Ansicht jeden Stand wählen und mit ▶ im Review-Container starten (eigener Port,
   eigene Datenbank-Kopie). Dasselbe geht im Sprint-Popover der Kopfzeile (Desktop): Es zeigt Fortschritt und die
   nächsten offenen Aufträge, startet den gewählten Stand und öffnet den Container in einem neuen Tab, sobald er läuft.
6. **Sprint-Review:** Sind alle Aufträge durch, wartet der Sprint auf dein Go (Push-Nachricht, Hinweis im Sprint).
   Der Autopilot schaltet nie selbst live.
7. **Live schalten:** Tests und CI laufen, der Sprint wird nach `main` gemergt, der Projektordner (z. B. mit dev-live)
   auf `main` nachgezogen und die Deploy-Befehle laufen. Live ist damit immer der freigegebene Stand von `main`.
