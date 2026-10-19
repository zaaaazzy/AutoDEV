# Workflows im Dev Log

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

| Status        | Bedeutung                                                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Geplant       | Sprint angelegt, Aufträge zuordenbar; der Worker arbeitet nichts ab.                                                                                |
| Aktiv         | Maximal **ein** aktiver Sprint pro Projekt (DB-Constraint). Backlog-Aufträge des Sprints werden automatisch auf „Geplant“ gesetzt und abgearbeitet. |
| Abgeschlossen | Sprint-Bericht wird erzeugt; die Git-Sicherung wird automatisch eingereiht (DB-Trigger).                                                            |

## 3a. Sprintplanung und Autopilot

Pro Projekt einstellbar (Einstellungen → Sprintplanung, `projects.sprint_mode`):

| Modus                   | Verhalten                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `manual` (Standard)     | Sprints werden selbst zusammengestellt; der Vorschlag erscheint nur auf Knopfdruck („Nächsten Sprint vorschlagen“).                            |
| `suggest` (vorschlagen) | Sprints zeigt immer die Karte „Vorschlag für Sprint N“; „Übernehmen“ bzw. „Übernehmen und starten“ per Klick.                                  |
| `autopilot`             | Wie `suggest`, zusätzlich schliesst der Worker fertige Sprints ab und startet den nächsten Vorschlag selbst – nur innerhalb der Arbeitszeiten. |

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
3. **Auto-Abschluss:** Ein aktiver Sprint wird abgeschlossen, sobald kein Auftrag mehr `backlog`, `planned` oder `in_progress` ist und alle verbleibenden `blocked`-Aufträge „Aktion notwendig“ haben. Blockierte ohne Aktion sind Fehler, die noch behoben werden, und halten den Sprint offen. Der Abschluss erzeugt den Bericht und reiht die Git-Sicherung ein (Test-Gate, Merge, Tag, Push). Er geht auch ausserhalb der Arbeitszeiten, weil dabei kein Agent läuft.
4. **Nächster Sprint:** Nur innerhalb der Arbeitszeiten (`autopilot_start`, `autopilot_end`, `autopilot_days`; Standard Mo–Fr 08:00–18:00, Ortszeit des Workers; „Bis“ vor „Von“ = über Mitternacht, gleiche Zeiten = ganztägig). Der Vorschlag wird übernommen und gestartet; die „Aktion notwendig“-Aufträge wandern mit. Enthält der Vorschlag nur solche Aufträge, startet kein Sprint.

**Grenzen:**

- **Kein Budget:** Das Budget-Feature (Idee 04) gibt es noch nicht, deshalb prüft der Autopilot kein Budget. Einzige Kostengrenze sind die Arbeitszeiten. Kommt Idee 04, gehört die Prüfung in `autopilotGuard` (`src/api/sprint-planning.ts`).
- Die Kapazität vergleicht gemessene Agent-Laufzeit mit geschätzten Stunden der Kandidaten. Bei wenig Historie ist der Median ungenau. Sprints ohne gemessene Laufzeit (z. B. von Hand erledigt) zählen nicht als Historie.
- Die Roadmap rechnet mit der heutigen Kapazität und nimmt an, dass alle eingeplanten Aufträge erledigt werden.
- Bereits geplante, noch nicht gestartete Sprints und ihre Aufträge fliessen nicht in Vorschlag und Roadmap ein.

## 4. Abarbeitung eines Auftrags (`runWorkItem`)

- **Auswahl:** Status `planned` und (Sprint aktiv **oder** fester Agent **oder** `auto_run`). Reihenfolge: Priorität hoch → niedrig, dann Alter. Bis zu 3 Aufträge pro Durchgang; Entwickler und Tester arbeiten aber nie gleichzeitig an zwei Aufträgen (siehe unten).
- **Sperre:** Pro Auftrag nur ein Lauf (`agent_runs` mit Status `running` ist eindeutig); Läufe älter als 3 h gelten als fehlgeschlagen.
- **Agents:** Aktivierte Agents laufen nach Phase (`pre_task`, `while_task`, `after_task`) und Position. Der erste fehlgeschlagene Schritt beendet den Lauf.
- **Informationsfluss:** Entwickler erhalten Anforderung und Risiken; jeder Agent bekommt die Ergebnisse der vorherigen Agents (Entwickler: Dateiliste → Tester → Dokumentierer → Handbücher).
- **Nach jedem Schritt:** Dokumentierer → Auftragsdoku, Handbuch-Autoren → Handbücher, Entwickler bei Bug-Aufträgen → Fix-Notiz am Bug.
- **Abbruch:** Der Nutzer kann einen Lauf abbrechen (Status Blockiert). Beim Herunterfahren des Workers wird der Auftrag zurück auf „Geplant“ gesetzt und läuft beim nächsten Start weiter.
- **Sofortstart:** Wird ein Auftrag eingeplant (neu, „Erneut versuchen“, Bugfix, Sprint gestartet), meldet die Datenbank das per `NOTIFY devlog_work`; der Worker startet den nächsten Durchgang sofort statt nach bis zu 30 s. Ein frei werdender Platz weckt ihn ebenfalls. Das Intervall bleibt als Absicherung.
- **Kurze Ausfälle:** Scheitert ein Schritt vorübergehend (Modell nicht erreichbar, überlastet, Rate-Limit, Verbindung abgebrochen, Zeitlimit), wird er nach 30 s einmal wiederholt. Erst wenn auch das scheitert, gilt der Schritt als fehlgeschlagen. Im Verlauf steht „Vorübergehender Fehler – neuer Versuch“.
- **Kostenbremse:** In den Projekteinstellungen lässt sich eine Grenze je Auftrag setzen (Tokens und/oder USD). Vor jedem Agent prüft der Worker den Verbrauch des Auftrags seit dem letzten „Erneut versuchen“; ist die Grenze erreicht, startet kein weiterer Agent. Der Auftrag wird blockiert mit „Aktion notwendig: Kostengrenze erreicht …“ – ohne Bug und ohne Bugfix. „Erneut versuchen“ gibt ihm ein neues Budget (`budget_since`).
- **Zeitleiste:** Die Detailansicht zeigt oben in einem Satz, worauf der Auftrag gerade wartet (z. B. „Wartet auf die Problemanalyse“, „Wartet auf deine Antwort“, „Wartet auf den Start des Sprints“), und aufklappbar, wann welcher Agent lief, Statuswechsel, Analyse, Rückfragen und Bugfix (`GET /api/development/:id/timeline`; Statuswechsel speichert ein Trigger in `development_events`).
- **Einzelner Agent (Play-Knopf):** Läuft nur dieser Agent; danach wird der frühere Status wiederhergestellt. Es gibt dabei **keinen** Auftrags-Commit und keine automatische Wiederaufnahme.

## 4a. Workflow-Board (Agents → Workflow)

Unter „Agents“ zeigt ein Kanban, wann welcher Agent läuft. Phase und Reihenfolge stehen in `agents.phase` und
`agents.position`; Ziehen speichert beides (`POST /api/projects/:slug/agents/order`). Ein Klick auf eine Karte zeigt
die Einstellungen, ✎ macht sie bearbeitbar (dasselbe Formular wie in der Agent-Tabelle).

| Spalte | Phase | Wann |
|---|---|---|
| Vor dem Sprint | `pre_sprint` | einmal, wenn ein Sprint aktiv wird, bevor sein erster Auftrag startet; nur lesend (Rolle `pre_sprint` in `READ_ONLY_ROLES`). Das Ergebnis steht in `sprints.pre_sprint_notes` und steht in jeder Agent-Anweisung der Aufträge dieses Sprints. |
| Vor dem Auftrag | `pre_task` | für jeden Auftrag, vor der Umsetzung |
| Während | `while_task` | Umsetzung |
| Danach | `after_task` | Tests, Review, Doku |
| Bei abgelehnt | `on_rejected` | am Ende eines gescheiterten Auftrags (nicht bei Unterbrechung oder Kostenbremse) |
| Bei abgeschlossen | `on_done` | am Ende eines erfolgreichen Auftrags |

„Bei abgelehnt/abgeschlossen“ laufen noch vor dem Abschluss des Auftrags (ihre Änderungen landen im Commit), ändern
aber sein Ergebnis nicht: kein Bug, keine Abnahme, kein Statuswechsel.

**Nachrichten zwischen Agents:** Ein Agent schreibt `@@NACHRICHT: …` (an den nächsten Agent) oder
`@@NACHRICHT an <Name>: …`. Ist beim Absender „Nachricht geht an“ (`agents.handoff_to`) gesetzt, geht eine Nachricht
ohne Namen dorthin. Der Empfänger sieht sie unter „Nachrichten an dich“; gespeichert sind sie in
`agent_run_steps.handoffs`. Implementierung: `src/core/workflow-phases.ts`, `src/runner/pre-sprint.ts`.

## 5. Fehlerbehandlung und Auto-Bugfix

0. **Nachbesserung im selben Lauf:** Sind die Tests rot oder lehnt der Reviewer ab, geht der Auftrag zuerst einmal direkt zurück an den Entwickler – mit der Ausgabe von Tester bzw. Reviewer als Rückmeldung. Danach laufen Entwickler, Tester und Reviewer erneut. Erst wenn auch dieser Versuch scheitert, greift der folgende Ablauf. Die erste Rückmeldung bleibt als fehlgeschlagener Schritt im Lauf sichtbar („Zurück an den Entwickler zur Nachbesserung“). Bei einem einzelnen Agent (Play-Knopf) gibt es keine Nachbesserung.
1. Ein Schritt scheitert → Auftrag wird **Blockiert**, der Fehler am Auftrag gespeichert, ein **Bug-Bericht** angelegt. Das gilt in allen Phasen, also auch für Tester und Reviewer in `after_task`; nur Fehler der Doku-Agents (Dokumentierer, Handbuch-Autoren) blockieren den Auftrag ohne Bug.
   Ausnahme: Scheitert der Agent selbst (Zeitlimit, Schleife, Schrittlimit, keine Dateien geändert, Modell nicht erreichbar, Befehl nicht gefunden), entsteht **kein** Bug und kein Bug-Auftrag – der Auftrag bleibt blockiert und die Problemanalyse wird angefordert.
2. Danach prüft die Problemanalyse (Rolle `analyst`, nur lesend) den Fehler. Erst wenn sie einen **Code-Fehler bestätigt** und `auto_bugfix` am Projekt aktiv ist (Standard), entsteht **einmalig** ein Bug-Auftrag (hohe Priorität, `auto_run`, auch ohne Sprint). Findet sie keinen Code-Fehler, bleibt der Auftrag mit „Aktion notwendig“ und ihrem Vermerk blockiert.
3. Ist der Bug-Auftrag erfolgreich, wird der Ursprungsauftrag erneut geplant (`auto_run`). **Höchstens 2 automatische Wiederholungen** (`retry_count`).

4. Scheitert ein Bug-Auftrag selbst, entsteht kein weiterer Bug (keine Endlosschleife); stattdessen wird eine Problemanalyse durch den Assistenten angefordert (nur lesend, Rolle `analyst`).
5. `backfillFailures` holt Bug-Berichte für ältere blockierte Aufträge nach.

**Wiederholung:** Ein blockierter Auftrag lässt sich in der Auftragsansicht und im Sprint („Erneut versuchen“) neu starten. Vorher fragt ein Bestätigungsdialog nach; ein optionaler Kommentar wird mit Datum unter „Hinweis zum erneuten Versuch“ an die Beschreibung gehängt und geht so an die Agents. Nach einem fehlgeschlagenen Lauf laufen nur der fehlgeschlagene Agent und die folgenden erneut; vorher erfolgreiche Agents werden übersprungen, ihre Ausgabe geht weiter an die Nachfolger.

**Rückfragen bei Chat-Aufträgen:** Braucht der Assistent bei einem Express-Auftrag aus dem Chat eine Antwort, zeigt der Auftrag (Liste und Detailansicht) die offene Frage samt Antwortoptionen. Die Antwort lässt sich direkt dort geben; sie wird als Antwort auf die Frage in den Chat gestellt (`GET /api/development/:id/question`, danach `POST …/chat` mit `replyTo`).

**Bestätigung mit Kommentar:** „Erneut versuchen“, „Sprintvorschlag übernehmen“ und alle Schnellaktionen des Assistenten (Aktionen, Tests, Visionär, Dev Log neu starten) öffnen zuerst ein eigenes Modal. Der optionale Kommentar wird mitgegeben: beim Sprintvorschlag als Sprintziel, bei Aktionen als „Hinweis dazu“ im Auftrag an den Assistenten, beim Visionär als Fokus, bei Testläufen und Neustarts gespeichert.

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

**Dev Log entwickelt sich selbst:** Arbeiten die Agents in einem eigenen Worktree, ist `main` im Arbeitsordner der Menschen ausgecheckt und wird dort normalerweise nicht angefasst. Mit der Projekteinstellung „Nach dem Sprint-Abschluss Dev Log neu starten“ (`restart_after_sprint`) übernimmt der Worker den abgeschlossenen Sprint dort selbst – aber nur, wenn im Ordner keine Änderungen offen sind und `main` ausgecheckt ist. Danach läuft das Test-Gate in diesem Ordner; ist es rot, wird der Merge mit `git reset --keep ORIG_HEAD` zurückgenommen. Klappt alles, wird `main` gepusht (falls ein Repository hinterlegt ist) und „Dev Log neu starten“ angefordert.

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
