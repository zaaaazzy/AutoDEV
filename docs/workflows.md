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

### 2a. Herkunft-Filter in der Ideation-Liste

Jede Idee zeigt in der Spalte „Herkunft“, woher sie stammt. Die Bezeichnungen sind dieselben wie die Badges („Visionär“ steht für Ideen vom Visionär, `source = visionary`):

| Wert       | Bedeutung                                                                |
| ---------- | ------------------------------------------------------------------------ |
| Mensch     | von Hand erfasst; ältere Ideen ohne Angabe gelten ebenfalls als „Mensch“ |
| Visionär   | vom Visionär-Agenten vorgeschlagen (Badge „Visionär“)                    |
| Routine    | von einer Routine angelegt                                               |
| Produktion | Idee mit Herkunft Produktion                                             |
| GitHub     | Idee mit Herkunft GitHub                                                 |

**So filtern Sie:** Auf den Trichter neben dem Spaltenkopf „Herkunft“ klicken. Das Menü zeigt „Alle“ und jede Herkunft mit der Anzahl der Ideen. Auch Herkunften ohne Treffer stehen in fester Reihenfolge darin, mit der Anzahl 0.

**Bedingungen:**

- Mehrere Herkünfte gleichzeitig wählen: Die Liste zeigt Ideen, die mindestens eine der gewählten Herkünfte haben (z. B. Visionär und GitHub).
- Der Herkunft-Filter lässt sich mit allen anderen Spaltenfiltern kombinieren, etwa Herkunft „Visionär“ mit einem Status-Filter. Dann erscheinen nur Ideen, die beide Bedingungen erfüllen. Dabei kann die Liste leer bleiben.
- „Alle“ hebt den Herkunft-Filter auf. Ist kein Filter gesetzt, ist „Alle“ ausgewählt und nicht anklickbar.
- Ein aktiver Filter erscheint als Chip über der Tabelle. Mit dem × am Chip oder „Filter leeren“ im Menü wird er entfernt; „Zurücksetzen“ leert alle Spaltenfilter, Suche und Sortierung auf einmal.
- **Nach dem Neuladen der Seite ist der Filter wieder auf „Alle“.** Das gilt auch für die anderen Spaltenfilter, die ebenfalls nicht gespeichert werden.

**Keine Änderung** an den Ideen selbst: Der Filter blendet nur Zeilen aus. Er ändert weder Herkunft noch Status.

## 3. Sprint-Lebenszyklus

| Status        | Bedeutung                                                                                                                                                                                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Geplant       | Sprint angelegt, Aufträge zuordenbar; der Worker arbeitet nichts ab.                                                                                                                                                                                                                                 |
| Aktiv         | Maximal **ein** aktiver Sprint pro Projekt (DB-Constraint). Backlog-Aufträge des Sprints werden automatisch auf „Geplant“ gesetzt und abgearbeitet.                                                                                                                                                  |
| Abgeschlossen | Sprint-Bericht wird erzeugt; die Git-Sicherung wird automatisch eingereiht (DB-Trigger).                                                                                                                                                                                                             |
| Abgebrochen   | Aus „Geplant“ oder „Aktiv“ („Abbrechen“). Laufende Agents der Sprint-Aufträge werden beendet, offene Aufträge verlassen den Sprint mit Vermerk (Backlog, unter „Aktionen“ wieder einplanbar), Erledigtes bleibt beim Sprint. Aufträge in Freigabe gehen ebenfalls ins Backlog (ihr Merge-Ziel war der Sprint-Branch), laufende erst nach dem Ende ihres Agents – bis dahin bietet die Oberfläche kein „Wieder einplanen“ an. Keine Git-Sicherung, kein Merge. Lässt sich wieder planen oder löschen. |

**Aufträge in einen Sprint nehmen („Aufträge hinzufügen“):** Auf der Sprintseite lassen sich offene und abgebrochene Aufträge in den Sprint übernehmen.

- **Welche Aufträge:** Status „Backlog“, „Geplant“ oder „Blockiert“ ohne Sprint, dazu Aufträge, die aus einem Sprint genommen wurden und wieder in einem dieser Status sind. Express-Anfragen, laufende Aufträge und Aufträge im Review („Freigabe“) stehen nicht zur Auswahl. Oberfläche und Server lesen dieselbe Statusliste (`src/core/development-transitions.ts`).
- **Wohin:** Nur in einen Sprint **desselben Projekts**, der geplant oder aktiv ist. Abgeschlossene oder abgebrochene Sprints nehmen nichts auf.
- **Was passiert:** Der Auftrag ist sofort im Ziel-Sprint, nicht erst im aktiven. Bei abgebrochenen oder blockierten Aufträgen werden Vermerk, Fehler und ein von Hand zugewiesener Agent zurückgesetzt. Blockierte zählen dabei als erneuter Versuch.
- **Start:** Nur in einem **aktiven** Sprint startet der Worker den Auftrag. In einem **geplanten** Sprint wartet er, bis der Sprint gestartet wird. Auch ein Verschieben per PATCH in einen nicht aktiven Sprint setzt das automatische Starten zurück.
- **Ablehnung:** Passt ein Auftrag oder Sprint nicht, meldet die Oberfläche „Nur offene oder abgebrochene Aufträge ohne Sprint lassen sich übernehmen …“. Ein Sammel-Hinweis nennt dann die nicht übernommenen Titel.
- **Freigabe und laufende Aufträge:** Sie stehen nicht unter „Aufträge hinzufügen“, weil ihre Arbeit an den Sprint gebunden ist und nicht umgehängt wird.

**„Wieder einplanen“ (unter „Aktionen“):** Der Schritt wird nur angeboten, wenn der Auftrag aus einem Sprint genommen wurde und im Status „Backlog“ oder „Geplant“ ist. Die Bedingung steht in `src/core/development-transitions.ts` und gilt genauso für `/retry`. Ein Auftrag in „Freigabe“ oder ein laufender Auftrag bietet ihn nicht an. Ein laufender Auftrag wird erst nach dem Ende seines Agent-Laufs frei und landet dann im Backlog. Freigaben aus einem abgebrochenen Sprint, die vor dieser Änderung ohne Sprint hängen geblieben sind, setzt die Migration `freigabe-nach-sprint-abbruch-ins-backlog` einmalig ins Backlog.

**Abschließen und Löschen mit offenen Aufträgen:** Laufen in einem Sprint noch Aufträge oder warten sie auf Freigabe, lehnt die API Abschluss (Live schalten) und Löschen mit 409 ab. Die Freigabe mergt erst später in den Sprint-Branch. Sonst landete sie in einem abgeschlossenen Sprint, nach Bericht und Tag, bzw. ohne Sprint. Erst freigeben oder zurückweisen und den Merge abwarten, dann abschließen oder löschen. Löschen lässt sich nur ein geplanter, abgeschlossener oder abgebrochener Sprint ohne laufende Git-Sicherung.

**Aktiven Sprint mit Startdatum in der Zukunft abschließen:** Wer einen Sprint vorzeitig startet (Startdatum liegt nach heute), kann ihn schon am selben Tag abschließen.

- **Bedingungen:** Der Sprint muss aktiv sein. Es darf kein Auftrag mehr laufen (409 „Im Sprint laufen noch Aufträge …“) und keiner auf die Review-Freigabe oder den Merge warten (409). Diese Regeln gelten unverändert.
- **Ergebnis:** Der Abschluss antwortet mit 200. Der Sprint steht auf „Abgeschlossen“, bekommt einen Sprintbericht und wird für die Git-Sicherung eingereiht.
- **Enddatum:** Ist kein Enddatum gesetzt, trägt Dev Log das Startdatum ein, wenn es in der Zukunft liegt, sonst heute. Das Enddatum liegt nie vor dem Startdatum.
- **Scheitert der Abschluss:** Status, Bericht und Git-Sicherung werden gemeinsam geschrieben oder gar nicht. Der Sprint bleibt dann aktiv, ohne Bericht und ohne Git-Sicherung, und der Abschluss lässt sich wiederholen. Der Worker mergt und pusht in diesem Fall nichts.
- **Grenze:** Ist ein Enddatum gesetzt, das vor dem Startdatum liegt, bleibt die Antwort 400 „Enddatum vor Startdatum“. Dann bleibt der Sprint ebenfalls aktiv; das Enddatum muss von Hand korrigiert werden.
- **Printscreens:** Keine. Die Änderung betrifft nur die Antwort des Abschlusses und den Inhalt der Daten. Die Oberfläche wurde nicht im Browser geprüft.

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
- **Einheit:** Planer, Routing und Statistik rechnen in **Agent-Stunden** (gemessene Laufzeit aller Agent-Schritte eines Auftrags) und gemessenen Tokens, nicht in Menschenstunden. Schnellschätzung und Auftragsautor schätzen in dieser Einheit und bekommen dafür die Ist-Werte ähnlicher Aufträge.
- **Kalibrierung** (`src/core/estimate-calibration.ts`): Jede Schätzung merkt sich ihre Herkunft (`estimate_source`: `manual` von Hand, `quick` Schnellschätzung, `author` Auftragsautor, leer = Altbestand in Menschenstunden). Je Herkunft gilt ein Faktor = Median von Ist ÷ Schätzung der letzten 20 erledigten Aufträge mit Messung, getrennt für Stunden und Tokens; ab 5 Messwerten der Projektwert, sonst der Wert aller Projekte, sonst 1 (begrenzt auf 0,01–10). Der Planer rechnet mit den kalibrierten Werten; die Karte zeigt die Faktoren („Altbestand ×0,04 (19 Aufträge)“), ein Tooltip die gespeicherte Schätzung. Der Auftragsautor ersetzt Schnellschätzung und Altbestand, von Hand eingetragene Werte nie.
- **Kapazität** = `sprint_capacity_hours` in Agent-Stunden (Standard 4 h; ein Auftrag braucht gemessen meist 0,2–0,5 h). Ein Sprint-Budget in Tokens (Einstellungen → Budget) ist zusätzlich die Token-Grenze. Die Historie bestimmt die Kapazität nicht – ein Sprint ohne Zeitfenster schafft genau, was eingeplant war –, die Karte zeigt aber den Median der gemessenen Agent-Stunden der letzten 3 Sprints (`completedSprintUsage` in `src/api/usage.ts`).
- Aufgefüllt wird nach Score, solange die kalibrierten Stunden (ohne Schätzung 0,5 h) und Tokens in die Kapazität passen; der erste Auftrag passt immer.
- Reihenfolge (`sprint_rank`): Ein Folgeauftrag kommt nur mit oder nach seinem Vorgänger in den Sprint und steht immer dahinter. Aufträge mit denselben betroffenen Dateien (Abschnitt „Technische Hinweise“ der Anforderung) stehen direkt hintereinander und laufen damit nacheinander unter der Projektsperre.
- „Aktion notwendig“-Aufträge (`blocked` mit `action_todo`) aus dem vorigen Sprint werden immer übernommen. Andere blockierte Aufträge werden normal bewertet.

**Vorschlagskarte:** Tabelle mit Begründung, Score, Stunden und Tokens je Auftrag; Summenzeile mit Stunden, Tokens und geschätzten Kosten. Die Kosten sind Tokens × Durchschnittspreis je Token aus den gemessenen Kosten (`tokenPriceUsd`, erst Projekt, sonst alle Projekte; ohne Messwerte Referenzpreis 5 $ je 1 Mio. Tokens). Ab- und Zuwählen aktualisiert die Summen sofort. „Übernehmen“ legt den Sprint an (Status geplant), ordnet die gewählten Aufträge zu und setzt `sprint_rank` in der angezeigten Reihenfolge; „Übernehmen und starten“ setzt ihn zusätzlich aktiv (nur, wenn kein anderer Sprint aktiv ist).

**KI-Kommentar (optional):** Der Knopf „🤖 KI-Kommentar“ reiht eine Anfrage ein (`sprint_proposal_comments`); der Worker lässt den Auftragsautor die aktuelle Auswahl in 3–5 Sätzen kommentieren (Sprintziel, Risiken). Reiner Text, höchstens 5 Sätze, ohne Einfluss auf die Auswahl. Beim Übernehmen wird er gelöscht und nicht am Sprint gespeichert.

**Roadmap:** „🗺 Roadmap“ berechnet die nächsten 3 Sprints nacheinander mit derselben Kapazität voraus. Eingeplante Aufträge gelten für die folgenden Sprints als erledigt (Folgeaufträge rücken nach) und erscheinen nicht erneut. Die Vorschau legt nichts an und ändert nichts (`GET …/sprints/roadmap`).

**Autopilot** (`src/runner/sprint-autopilot.ts`, am Anfang jedes Worker-Zyklus):

1. **Pause:** Ist die Git-Sicherung des zuletzt abgeschlossenen Sprints gescheitert (Merge-Konflikt, Test-Gate, Push), pausiert der Autopilot. Sprints zeigt die Meldung mit dem Git-Fehler, dazu kommt einmalig eine Push-Nachricht. Er startet keinen neuen Sprint, bis die Sicherung erneut erfolgreich läuft oder jemand mit der Rolle Planung „Autopilot freigeben“ klickt (`autopilot_released_sprint`). Der Merge- und Tag-Ablauf selbst bleibt unverändert. Steht die Sicherung auf „Wartet auf Merge“ (main in einem anderen Ordner mit offenen Änderungen, Abschnitt 6), pausiert der Autopilot nicht, wartet aber („finishing“, Begründung in Sprints). Den nächsten Sprint startet er erst, wenn `main` den letzten enthält.
2. **Abschluss läuft:** Solange die Sicherung `pending`/`running` ist, wartet er.
3. **Sprint fertig → Review:** Ein aktiver Sprint gilt als fertig (`sprintSettled`), sobald kein Auftrag mehr `backlog`, `planned`, `in_progress` oder `approval` (wartet auf Review-Freigabe) ist und alle verbleibenden `blocked`-Aufträge „Aktion notwendig“ haben. Blockierte ohne Aktion sind Fehler, die noch behoben werden, und halten den Sprint offen; ebenso wegen Tages- oder Sprint-Budget blockierte (`budget_blocked`), die von selbst weiterlaufen (das Budget je Auftrag gibt nie von selbst frei und hält den Sprint nicht offen), und solche, die nur an der Umgebung scheiterten („Arbeitsordner aufräumen (Git)“, Laufwerk nicht erreichbar). Abgelehnte Aufträge und Express-Anfragen aus dem Chat zählen nicht. Dann setzt `markSprintReady` `review_ready_at` und meldet einmal per Push „Sprint fertig“; der Autopilot wartet (`review`) und schliesst den Sprint nur mit „Autopilot schaltet selbst live“ (`autopilot_auto_live`, innerhalb der Arbeitszeiten, nicht bei pausiertem Sprint oder laufendem Auftrag) selbst ab. Abgeschlossen wird er mit dem Go („Live schalten“ in Sprints, Status `completed`) – das erzeugt den Bericht und reiht die Git-Sicherung ein (Test-Gate, Merge, Tag, Push). Optional schliesst der Wartungs-Job `close_old_sprints` fertige Sprints nach längerer Ruhe (Standard 14 Tage).
4. **Nächster Sprint:** Nur innerhalb der Arbeitszeiten (`autopilot_start`, `autopilot_end`, `autopilot_days`; Standard Mo–Fr 08:00–18:00, Ortszeit des Workers; „Bis“ vor „Von“ = über Mitternacht, gleiche Zeiten = ganztägig). Der Vorschlag wird übernommen und gestartet; die „Aktion notwendig“-Aufträge wandern mit. Enthält der Vorschlag nur solche Aufträge, startet kein Sprint.

**Grenzen:**

- **Budget:** Der Autopilot selbst prüft kein Budget; die Läufe, die er anstößt, halten aber die Budget-Limits ein (Abschnitt 4, „Budget“). Eine eigene Prüfung im Autopiloten gehört in `autopilotGuard` (`src/api/sprint-planning.ts`, eigener Auftrag).
- Die Kalibrierung ist nur so gut wie die Messung: Solange Cache-Tokens nicht mitgezählt werden, sind gemessene Tokens zu niedrig, der Token-Faktor gleicht das nur bei gleichbleibender Messung aus. Mit unter 5 erledigten Aufträgen einer Herkunft gilt der Wert aller Projekte bzw. 1.
- Die Roadmap rechnet mit der heutigen Kapazität und nimmt an, dass alle eingeplanten Aufträge erledigt werden.
- Bereits geplante, noch nicht gestartete Sprints und ihre Aufträge fliessen nicht in Vorschlag und Roadmap ein.

## 4. Abarbeitung eines Auftrags (`runWorkItem`)

- **Auswahl:** Status `planned` und (Sprint aktiv **oder** fester Agent **oder** `auto_run`). Reihenfolge: Priorität hoch → niedrig, dann Alter. Bis zu 3 Aufträge pro Durchgang; Entwickler und Tester arbeiten aber nie gleichzeitig an zwei Aufträgen (siehe unten). Vor dem Start wird jeder ausgewählte Auftrag erneut geprüft (noch `planned`, Sprint aktiv und nicht pausiert); wurde er inzwischen abgelehnt, zurückgestellt oder aus dem Sprint genommen, wird er übersprungen. Scheitert ein Auftrag unerwartet, laufen die übrigen weiter.
- **Arbeitsordner nicht sauber:** Liegen im Arbeitsordner der Agents fremde Änderungen oder steht er auf dem falschen Branch (`OrderBranchError`), betrifft das jeden Auftrag. Der Auftrag bleibt deshalb eingeplant (10 Minuten Wartezeit, `retry_after`), sein Sprint wird pausiert (`paused_by` = „AIdeation (Arbeitsordner nicht sauber)“) und es kommt genau eine Push-Nachricht. Nach dem Aufräumen (Dashboard: Git-Hinweis mit „Zwischenstand sichern“) geht es mit „Fortsetzen“ weiter.
  - **Berichte der Agents sind keine fremden Änderungen:** Tester und Test-Gate schreiben nach `docs/tests/`, der Bug-Wächter nach `docs/risiken/` (oft schon vor dem Auftrags-Branch). Diese Ordner nimmt der Auftrags-Commit nicht mit, und sie pausieren den nächsten Auftrag nicht. Sie bleiben unversioniert liegen, bis die Sprint-Sicherung sie committet. Dabei gilt der Secret-Holdback: Ein Bericht, der nach Zugangsdaten aussieht, wird nicht committet. Andere Dateien, auch `docs/risiken-x/` oder `docs/andere.md`, gelten weiter als fremd. Die Liste der Ordner steht einmal in `REPORT_DIRECTORIES` (`src/runner/git-sync/report-copies.ts`).
- **Nutzungslimit und Ordnerproblem gelten fürs ganze Projekt:** Solange ein Auftrag des Projekts wegen des Nutzungslimits des Agent-Kontos oder eines unsauberen Arbeitsordners wartet (`retry_after`), startet kein anderer Auftrag des Projekts (ausser ein von Hand gestarteter Agent).
- **Nach einem Neustart:** Der Worker räumt den Agent-Arbeitsordner einmal auf, bevor Arbeit beginnt: verwaiste `index.lock` (von niemandem gehalten) wird umbenannt, ein halber Merge/Rebase abgebrochen, ein unterbrochener Auftrag mit WIP-Commit auf seinem Branch gesichert und übrige Änderungen auf `wip/neustart-…` geparkt. Nichts wird verworfen; der Ordner der Menschen wird nicht angefasst.
- **Sprint-Branch bleibt aktuell:** Vor jedem neuen Auftrag eines Sprints holt der Worker den aktuellen `main` (bei Bedarf von GitHub) in den Sprint-Branch. Konflikte zeigen sich so früh und klein; lässt sich `main` gerade nicht konfliktfrei übernehmen, bleibt der Sprint-Branch unverändert und der Auftrag läuft weiter.
- **Hängende Aufträge:** Scheitert der Abschluss eines Auftrags (z. B. Datenbank kurz weg) oder stirbt der Worker dazwischen, wird ein Auftrag „In Arbeit“ ohne laufenden Lauf blockiert (Hinweis „Abschluss unterbrochen“, kein Bug) – am Anfang jedes Durchgangs und beim Worker-Start.
- **Verwaiste Läufe ohne Neustart:** Ist die Datenbank beim Abschluss weg, wiederholt der Worker das Blockieren des Auftrags und das Schliessen des Laufs bis zu fünfmal im Abstand von 15 s (nur bei Verbindungsfehlern, nicht bei SQL-Fehlern; Merge und Commit laufen nicht doppelt). Bleibt ein Lauf trotzdem auf „läuft“, räumt ihn der Dauer-Worker alle 15 s auf (`closeOrphanedRuns` in `src/runner/runner.ts`). Das gilt für Läufe seiner Projekte, die kein Auftrag dieses Workers mehr hält und die seit 5 Minuten kein Lebenszeichen haben. Der Schritt wird `failed` mit „Unterbrochen: …“ markiert, der Auftrag wieder auf „Geplant“ gesetzt. Verwaist derselbe Auftrag ein drittes Mal, wird er stattdessen blockiert. Wurde auf einem solchen Schritt „Abbrechen“ gedrückt, endet er beim nächsten Takt (binnen 15 s, frühestens 30 s nach dem letzten Lebenszeichen) mit Exit-Code 130, und der Auftrag wird blockiert. Tokens und Kosten bleiben stehen.
- **Sperre:** Pro Auftrag nur ein Lauf (`agent_runs` mit Status `running` ist eindeutig). Ein Lauf gilt erst als verwaist und fehlgeschlagen, wenn er länger als `ABANDONED_RUN_MS` kein Lebenszeichen gegeben hat (Start des Laufs oder letzter Eintrag im Verlauf eines Schritts). Die Schwelle wird aus dem höchsten Schritt-Zeitlimit abgeleitet (2 × 240 min samt Wiederholung, plus 30 s Pause und 1 h Reserve, also rund 9 h), damit ein zweiter Worker keinen lebenden Lauf abräumt (`src/runner/runner-runs.ts`).
- **Agents:** Aktivierte Agents laufen nach Phase (`pre_task`, `while_task`, `after_task`) und Position. Der erste fehlgeschlagene Schritt beendet den Lauf.
- **Informationsfluss:** Entwickler erhalten Anforderung und Risiken; jeder Agent bekommt die Ergebnisse der vorherigen Agents (Entwickler: Dateiliste → Tester → Dokumentierer → Handbücher).
- **Nach jedem Schritt:** Dokumentierer → Auftragsdoku, Handbuch-Autoren → Handbücher, Entwickler bei Bug-Aufträgen → Fix-Notiz am Bug.
- **Abbruch:** Der Nutzer kann einen Lauf abbrechen (Status Blockiert, ohne Bug-Bericht – auch nicht nachträglich über `backfillFailures`). Beim Herunterfahren des Workers wird der Auftrag zurück auf „Geplant“ gesetzt und läuft beim nächsten Start weiter.
- **Sofortstart:** Wird ein Auftrag eingeplant (neu, „Erneut versuchen“, Bugfix, Sprint gestartet), meldet die Datenbank das per `NOTIFY devlog_work`; der Worker startet den nächsten Durchgang sofort statt nach bis zu 30 s. Ein frei werdender Platz weckt ihn ebenfalls. Das Intervall bleibt als Absicherung.
- **Kurze Ausfälle:** Scheitert ein Schritt vorübergehend (Modell nicht erreichbar, überlastet, Rate-Limit, Verbindung abgebrochen, Zeitlimit), wird er nach 30 s einmal wiederholt. Erst wenn auch das scheitert, gilt der Schritt als fehlgeschlagen. Im Verlauf steht „Vorübergehender Fehler – neuer Versuch“. Wiederholt wird nur ein Fehler des Agents selbst: Rote Projekttests (eingebauter Tester, Testlauf nach dem CLI-Tester) und die visuelle Prüfung werden nie wiederholt, auch wenn ihre Ausgabe z. B. `ECONNREFUSED` enthält. Vor dem zweiten Versuch wird das Budget neu geprüft. Ist es erreicht, hält der Lauf ohne Bug-Bericht an, wie vor einem Schritt („Vorübergehender Fehler – kein neuer Versuch, das Budget ist erreicht“).
- **Budget:** Unter Einstellungen → Budget lassen sich je Projekt Limits für Tag, Sprint und Auftrag setzen (Tokens und/oder USD, Tabelle `budgets`; leer = unbegrenzt, ohne Limit keine Prüfung). Verbrauch = `agent_run_steps` + `agent_usage` im Zeitraum (Tag ab Mitternacht, Auftrag seit dem letzten „Erneut versuchen“, `budget_since`). Zum Sprint zählen nur die Läufe der Aufträge dieses Sprints ab Sprintbeginn – Chat, Auftragsautor, Visionär (`agent_usage`) und Aufträge ausserhalb des Sprints nicht. Ein Sprintlimit gilt nur für den aktiven Sprint: Hängt ein Auftrag an einem geplanten, abgeschlossenen oder abgebrochenen Sprint oder an einem Sprint im Review, prüft Dev Log für ihn kein Sprintlimit, und eine Sprintlimit-Blockade wird beim nächsten Durchgang frei. Bugfix-Aufträge übernehmen den Sprint des blockierten Auftrags nur, solange dieser nicht abgeschlossen oder abgebrochen ist; sonst kommen sie in den aktiven Sprint bzw. ohne Sprint auf `main`; Ollama zählt mit 0 USD, aber mit seinen Tokens. Vor jedem Agent-Schritt (`budgetGate`, `src/runner/budget.ts`) und vor jedem Lauf von Chat, Auftragsautor, Visionär usw. (`runAuthorAgent`) wird geprüft:
  - **ab 80 %:** genau eine Push-Warnung je Projekt, Zeitraum und Periode (gemerkt in `budget_warnings`);
  - **ab 100 %:** kein neuer Schritt; ein laufender Schritt endet regulär (das Limit kann um einen Schritt überschritten werden). Der Auftrag wird `blocked` mit „Aktion notwendig: Budget erreicht: erhöhen oder warten (…)“ – ohne Bug und ohne Bugfix; `budget_blocked` merkt den Zeitraum. Ist das Tages- oder Sprintbudget vor dem nächsten Auftrag erreicht – vor dem Durchgang oder mitten darin –, wartet genau ein Auftrag sichtbar, die übrigen bleiben eingeplant und starten keinen Lauf.
  - **Freigabe:** Zu Beginn jedes Durchgangs und nach dem Speichern der Limits (`releaseBudgetBlocks`) laufen Aufträge weiter, deren Zeitraum wieder Luft hat – das Tageslimit am Folgetag, sonst nach Erhöhen oder Entfernen des Limits; die Aktion verschwindet. „Erneut versuchen“ gibt einem Auftrag weiterhin ein neues Auftragsbudget.
- **Modell-Routing:** Regeln je Projekt (`routing_rules`, Reihenfolge = Priorität; ohne eigene Regeln die Standardregeln) wählen je Schritt die Stufe „lokal“ (Ollama-Modell) oder „stark“ (CLI-Befehl, z. B. Claude): `docs` → lokal, Schätzung < 0,1 h → lokal, `backend` und Schätzung > 0,5 h → stark (kalibrierte Agent-Stunden, siehe Abschnitt 3a), `retry_count ≥ 1` → eine Stufe höher, Budget > 80 % → eine Stufe tiefer. Die erste Regel mit fester Stufe bestimmt die Grundstufe, danach verschieben alle zutreffenden „höher/tiefer“-Regeln sie in ihrer Reihenfolge – bei zwei Stufen gewinnt also die letzte zutreffende Verschiebung (Budget-Bremse vor Retry-Eskalation). Ist für die Stufe kein Modell konfiguriert, bleibt die Modellwahl je Rolle; der Tester wird nie umgeleitet. Jeder Schritt speichert `model` und `routing_rule`; das Lauf-Detail zeigt z. B. „Modell: qwen3.5:9b (Regel: docs → lokal)“ (`src/agent/model-routing.ts`).
- **Zeitleiste:** Die Detailansicht zeigt oben in einem Satz, worauf der Auftrag gerade wartet (z. B. „Wartet auf die Problemanalyse“, „Wartet auf deine Antwort“, „Wartet auf den Start des Sprints“), und aufklappbar, wann welcher Agent lief, Statuswechsel, Analyse, Rückfragen und Bugfix (`GET /api/development/:id/timeline`; Statuswechsel speichert ein Trigger in `development_events`).
- **Sprint-Auswahl:** In Arbeit, in Freigabe und erledigt bleibt ein Auftrag in seinem Sprint (Sprint-Branch, Fortschritt, Bericht). Die Sprint-Auswahl im Auftragsdetail ist dann gesperrt; `PATCH /api/development/:id` lehnt einen anderen `sprintId` (auch „Kein Sprint“) mit 409 ab, derselbe Sprint wie bisher bleibt erlaubt.
- **Aus dem Sprint nehmen:** Das geht nur für offene, geplante oder blockierte Aufträge (`SPRINT_REMOVABLE_DEVELOPMENT_STATUSES`, `src/core/development-transitions.ts`) und nur aus geplanten oder aktiven Sprints. Alles andere lehnt `POST /api/development/:id/remove-from-sprint` mit 409 ab und schreibt nichts. Das gilt auch für Aufträge in Freigabe oder abgelehnte Aufträge, weil an ihnen noch der Review-Branch hängt, und für Sprints im Review, weil deren Branch schon im PR steckt. Auftrags- und Sprint-Status werden in derselben Anweisung geprüft. Auf der Sprintseite fehlen bei Sprints im Review oder danach auch Umsortieren (↑/↓), Herausnehmen und „Aufträge hinzufügen“.
- **Anlegen:** `POST /api/projects/:slug/development` legt einen Auftrag nur im Status `backlog` (Standard ohne Angabe) oder `planned` an. Jeder andere Status (z. B. `done`, `approval`, `in_progress`) ergibt 400 mit Feld `status`, und es wird nichts gespeichert. Weitere Status entstehen nur über die Übergänge von `PATCH` oder über den Worker.
- **Einzelner Agent (Play-Knopf):** Läuft nur dieser Agent; danach wird der frühere Status wiederhergestellt. Es gibt dabei **keinen** Auftrags-Commit und keine automatische Wiederaufnahme.
- **Visuelle Abnahme (`visual_tester`, nach dem Tester):** Nur bei Kategorie Frontend oder Fullstack und gesetzter Vorschau-Adresse (Einstellungen → Visuelle Prüfung), sonst ohne Fehler übersprungen. Playwright (Chromium, Profile „Desktop Chrome“ und „Pixel 7“ wie in `e2e/playwright.config.ts`) nimmt jede konfigurierte Seite auf; der Vergleich läuft gegen die zuletzt gespeicherte Aufnahme derselben Seite und desselben Geräts (kein zweiter Checkout) mit `pixelmatch`, solange es nicht installiert ist mit einem eingebauten Vergleich nach demselben Farbabstand. Masken (CSS-Selektoren) und Passwortfelder werden vor der Aufnahme abgedeckt. Geprüft werden Überbreite auf dem Handy (dieselbe Messung wie `?layoutcheck`, `src/core/layout-measure.ts`), Konsolenfehler, Ressourcen mit HTTP-Fehler oder fehlende Bilder, leere Seiten und abgeschnittene Texte (nur zur Ansicht). Die Befunde stehen als `@@CHECK`-Zeilen in der Ausgabe und als Prüfpunkte „Visuelle Prüfung“ in der Abnahme; manuelle Punkte wie „auf dem Handy prüfen“ hakt der Schritt ab, wenn alle Handy-Prüfungen bestanden sind. Optional beurteilt ein Bildmodell (Befehl des Agents, z. B. Claude-CLI, sonst ein Ollama-Bildmodell) jedes Akzeptanzkriterium. Der Schritt blockiert den Auftrag nie: Nach 3 Minuten oder bei technischen Fehlern erscheint „visuelle Prüfung nicht möglich“. Test-Logins stammen nur aus der `.env.example` des Projekts und erscheinen nie in Bildern, Logs oder Prüftexten. Im Auftrag zeigt der Reiter „Ansicht“ Vorher, Nachher und Diff je Gerät; „Optisch freigeben“ speichert Person und Zeitpunkt. Chromium prüft und installiert der Einrichtungsassistent (`npx --no-install playwright install chromium`).

## 4a. Workflow (Agents → Workflow)

Unter „Agents“ legt die aufklappbare Karte „Workflow“ fest, wann welcher Agent läuft. Gespeichert sind Einsätze in
`workflow_steps` (Phase, Position, Agent, eigene Anweisung, aktiv). Derselbe Agent kann mehrfach vorkommen, z. B.
der Tester einmal „Danach“ für die API und einmal für die Oberfläche; die Anweisung des Einsatzes kommt zusätzlich
zur Anweisung des Agents in den Prompt und hat Vorrang. „+ Agent“ fügt einen bestehenden oder neuen Agent an das
Ende einer Phase, ↑↓ ordnet, der Griff ⠿ zieht einen Einsatz innerhalb der Phase oder in eine andere Phase (Auswahl
„In Phase verschieben“ als Tastatur-Alternative; beides nur mit Recht `agents`), „Pausieren“ nimmt einen Einsatz aus dem Ablauf, „Entfernen“ löscht nur den Einsatz.
Projekte ohne Schritte übernehmen beim ersten Öffnen ihren bisherigen Ablauf (Phase und Position am Agent); bis
dahin gilt dieser auch im Worker. API: `GET /api/projects/:slug/workflow`, `POST …/workflow/steps`,
`POST …/workflow/order`, `PATCH|DELETE /api/workflow-steps/:id` (Recht „Agents verwalten“).

**Umbau während eines Laufs:** Ein laufender Auftrag arbeitet mit dem Workflow, der zu seinem Start galt, bis zum
Ende weiter. Wurde ein Einsatz oder Agent inzwischen entfernt, speichert sein Schritt keinen Verweis darauf
(`workflow_step_id` bzw. `agent_id` leer), Name und Phase bleiben sichtbar. Erst der nächste Lauf nutzt den neuen
Workflow. Bricht ein Lauf aus einem anderen unerwarteten Grund ab, steht am blockierten Auftrag immer die Begründung
„Lauf abgebrochen: …“.

| Zeitpunkt         | Phase         | Wann                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vor dem Sprint    | `pre_sprint`  | einmal, wenn ein Sprint aktiv wird, bevor sein erster Auftrag startet; nur lesend (Rolle `pre_sprint` in `READ_ONLY_ROLES`). Das Ergebnis steht in `sprints.pre_sprint_notes` und steht in jeder Agent-Anweisung der Aufträge dieses Sprints. Scheitert ein Agent, wird die Phase nach einer Pause wiederholt (2, dann 4 Minuten; höchstens 3 Versuche, danach starten die Aufträge ohne sie). Versuche und nächster Zeitpunkt stehen am Sprint (`pre_sprint_attempts`, `pre_sprint_next_at`) und überstehen einen Neustart. Bei erreichtem Budget oder Nutzungslimit des Agent-Kontos zählt kein Versuch, die Phase wird nachgeholt (beim Limit nach dem Reset). Fehlermeldungen werden nie Sprint-Hinweis. |
| Vor dem Auftrag   | `pre_task`    | für jeden Auftrag, vor der Umsetzung                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Während           | `while_task`  | Umsetzung                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Danach            | `after_task`  | Tests, Review, Doku                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Bei abgelehnt     | `on_rejected` | am Ende eines gescheiterten Auftrags (nicht bei Unterbrechung oder erreichtem Budget)                                                                                                                                                                                                                                                                                                                                                                               |
| Bei abgeschlossen | `on_done`     | am Ende eines erfolgreichen Auftrags                                                                                                                                                                                                                                                                                                                                                                                                                                |

„Bei abgelehnt/abgeschlossen“ laufen noch vor dem Abschluss des Auftrags (ihre Änderungen landen im Commit), ändern
aber sein Ergebnis nicht: kein Bug, keine Abnahme, kein Statuswechsel.

**Nachrichten zwischen Agents:** Ein Agent schreibt `@@NACHRICHT: …` (an den nächsten Agent) oder
`@@NACHRICHT an <Name>: …`. Ist beim Absender „Nachricht geht an“ (`agents.handoff_to`) gesetzt, geht eine Nachricht
ohne Namen dorthin. Als Empfänger ist nur ein Agent desselben Projekts erlaubt; `PATCH /agents/:id` lehnt fremde
IDs mit 400 ab, `null` hebt die feste Zuordnung auf. Der Empfänger sieht sie unter „Nachrichten an dich“; gespeichert sind sie in
`agent_run_steps.handoffs`. Implementierung: `src/core/workflow-phases.ts`, `src/runner/pre-sprint.ts`.

**Mandanten-Prüfung für ID-Felder (Pflicht für neue Routen):** Jede API-Route, die eine ID aus Pfad oder Body
übernimmt (z. B. `agentId`, `handoffTo`, `sprintId`, `developmentId`, `ids`), prüft vor jedem Schreiben und jeder
Folgeaktion mit `assertInProject(pool, tabelle, id, projektSlug)` (`src/api/tenancy.ts`), dass die ID zum Projekt der
Route gehört. Der Fremdschlüssel prüft das Projekt nicht, und `routeGuard` prüft nur den Mandanten der Route selbst
(`:slug` bzw. `:id`), für Administratoren gar nicht. Fremde IDs ergeben 400 (falsche Eingabe) oder 404 (nicht gefunden);
ein schon vorhandener Statuscode einer Route bleibt. Jede neue ID-Eingabe gehört zusätzlich in die Allowlist
`src/api/tenant-id-fields.ts`, mit Szenario in `src/api/tenant-ids.test.ts`. Der Test liest die registrierten
Express-Routen und ihren Quelltext, scheitert bei einem ID-Feld ohne Eintrag und schickt für jeden Eintrag eine ID aus
einem zweiten Projekt („fremd“): erwartet 400/404 und eine unveränderte Datenbank (Zeilenzahl und Inhalt aller
Tabellen). Die gültige ID aus dem eigenen Projekt muss weiter den bisherigen Erfolgsstatus liefern.

## 5. Fehlerbehandlung und Auto-Bugfix

0. **Nachbesserung im selben Lauf:** Sind die Tests rot oder lehnt der Reviewer ab, geht der Auftrag zuerst einmal direkt zurück an den Entwickler – mit der Ausgabe von Tester bzw. Reviewer als Rückmeldung. Danach laufen Entwickler, Tester und Reviewer erneut. Erst wenn auch dieser Versuch scheitert, greift der folgende Ablauf. Die erste Rückmeldung bleibt als fehlgeschlagener Schritt im Lauf sichtbar („Zurück an den Entwickler zur Nachbesserung“). Bei einem einzelnen Agent (Play-Knopf) gibt es keine Nachbesserung.
1. Ein Schritt scheitert → Auftrag wird **Blockiert**, der Fehler am Auftrag gespeichert, ein **Bug-Bericht** angelegt. Das gilt in allen Phasen, also auch für Tester und Reviewer in `after_task`; nur Fehler der Doku-Agents (Dokumentierer, Handbuch-Autoren) blockieren den Auftrag ohne Bug.
   Ausnahme: Scheitert der Agent selbst (Zeitlimit, Schleife, Schrittlimit, keine Dateien geändert, Modell nicht erreichbar, Befehl nicht gefunden), entsteht **kein** Bug und kein Bug-Auftrag – der Auftrag bleibt blockiert und die Problemanalyse wird angefordert. Meldet die Claude-CLI ihr Nutzungslimit („You've hit your session limit · resets …“), gilt das als Unterbrechung: der Auftrag bleibt geplant und startet erst nach der gemeldeten Reset-Zeit wieder (`retry_after`).
   **Unterbrechung ist keine Ablehnung:** Unterbrochen werden kann durch Shutdown des Workers, einen nicht erreichbaren Projektordner, einen Absturz-Neustart oder das Nutzungslimit. Der Schritt bleibt zwar `failed`, bekommt aber die Markierung `interrupted`. Beim nächsten Lauf übernimmt der Lauf bestandene Schritte davor und setzt beim selben Agent fort. Wurde der unterbrochene Schritt von Tester oder Reviewer ausgeführt, startet der Entwickler nicht. Nur eine echte Ablehnung durch Tester oder Reviewer führt zurück zum Entwickler, mit dessen Ausgabe als Rückmeldung.
2. Danach prüft die Problemanalyse (Rolle `analyst`, nur lesend) den Fehler. Erst wenn sie einen **Code-Fehler bestätigt** und `auto_bugfix` am Projekt aktiv ist (für neue Projekte standardmäßig aus), entsteht **einmalig** ein Bug-Auftrag (hohe Priorität, `auto_run`, auch ohne Sprint). Findet sie keinen Code-Fehler, bleibt der Auftrag mit „Aktion notwendig“ und ihrem Vermerk blockiert.
3. Ist der Bug-Auftrag erfolgreich, wird der Ursprungsauftrag erneut geplant (`auto_run`). **Höchstens 2 automatische Wiederholungen** (`retry_count`).

4. Scheitert ein Bug-Auftrag selbst, entsteht kein weiterer Bug (keine Endlosschleife); stattdessen wird eine Problemanalyse durch den Assistenten angefordert (nur lesend, Rolle `analyst`).
5. `backfillFailures` holt Bug-Berichte für ältere blockierte Aufträge nach.

**Wiederholung:** Ein blockierter Auftrag lässt sich in der Auftragsansicht und im Sprint („Erneut versuchen“) neu starten. Vorher fragt ein Bestätigungsdialog nach; ein optionaler Kommentar wird mit Datum unter „Hinweis zum erneuten Versuch“ an die Beschreibung gehängt und geht so an die Agents. Nach einem fehlgeschlagenen Lauf laufen nur der fehlgeschlagene Agent und die folgenden erneut; vorher erfolgreiche Agents werden übersprungen, ihre Ausgabe geht weiter an die Nachfolger.

**Sprint beim erneuten Versuch:** „Erneut versuchen“ (`POST /development/:id/retry`) und „Zurückweisen“ in der Review-Freigabe behalten den bisherigen Sprint nur, wenn er geplant oder aktiv ist. Liegt er im Review, ist er abgeschlossen oder abgebrochen, kommt der Auftrag in den aktiven Sprint des Projekts, ohne aktiven Sprint auf `main`. Sonst liefe er auf dem alten Sprint-Branch. Optional nimmt `/retry` `{ sprintId }` an: Status und Sprint werden dann in einem einzigen UPDATE gesetzt. Ein Sprint im Review, ein abgeschlossener, ein abgebrochener oder einer aus einem anderen Projekt ergibt 409, und es wird nichts geschrieben. `auto_run` folgt dem Ziel-Sprint: Ohne Sprint oder im aktiven Sprint startet der Auftrag sofort, in einem geplanten erst mit dem Sprintstart. Die Logik steht in `retrySprintSql` und `retryAutoRunSql` in `src/api/development.ts`.

**Rückfragen bei Chat-Aufträgen:** Braucht der Assistent bei einem Express-Auftrag aus dem Chat eine Antwort, zeigt der Auftrag (Liste und Detailansicht) die offene Frage samt Antwortoptionen. Die Antwort lässt sich direkt dort geben; sie wird als Antwort auf die Frage in den Chat gestellt (`GET /api/development/:id/question`, danach `POST …/chat` mit `replyTo`).

**Bestätigung mit Kommentar:** „Erneut versuchen“, „Sprintvorschlag übernehmen“ und alle Schnellaktionen des Assistenten (Aktionen, Tests, Visionär, AIdeation neu starten) öffnen zuerst ein eigenes Modal. Der optionale Kommentar wird mitgegeben: beim Sprintvorschlag als Sprintziel, bei Aktionen als „Hinweis dazu“ im Auftrag an den Assistenten, beim Visionär als Fokus, bei Testläufen und Neustarts gespeichert.

**Rückfrage per Push:** Die Push-Nachricht einer Rückfrage zu einem Auftrag öffnet direkt diesen Auftrag im richtigen Projekt und setzt den Cursor ins Antwortfeld (`#development/<id>?project=<slug>&answer=1`).

**Behoben und dokumentiert:** Schließt der Bug-Auftrag erfolgreich ab, setzt ein DB-Trigger den Bug auf „Behoben“. Die Lösung (Ausgabe des Entwicklers) steht am Bug (`fix_notes`) und wird allen späteren Agents als „bekannte Bugs mit Lösung“ mitgegeben. Der Bug-Fix lässt sich per Klick am Bug, am Auftrag oder im Sprint starten.

## 5a. Betrieb: Log-Scan und Bug-Detail

Der Log-Scan liest die Container-Logs des Projekts und erfasst Fehler aus dem Betrieb als Bug mit Quelle „Betrieb“. Er wird in den Einstellungen „Betrieb“ eingerichtet.

**Einrichten:** In den Einstellungen unter „Betrieb“ die Compose-Dienste eintragen, etwa `api, web`. Nur gültige Dienstnamen werden an `docker compose logs` übergeben; der Befehl läuft ohne Shell. Außerdem lassen sich Ausschlussmuster (eines pro Zeile) und die Aufbewahrung in Tagen (1 bis 365) festlegen.

**Wann gescannt wird:** Alle 15 Minuten und nach jedem erfolgreichen Deploy, mit derselben Logik.

**Bedingungen:**

- **Ohne Dienste kein Scan.** Ist für das Projekt kein Dienst eingetragen, findet kein Aufruf statt. Die Einstellungen zeigen dann keine Scan-Angaben.
- **Lückenloses Fenster.** Jeder Scan liest ab dem Zeitpunkt des letzten erfolgreichen Scans. Ein verspäteter Lauf erfasst die Zeit dazwischen vollständig. Zeilen, die ein früherer Scan schon gezählt hat, zählen nicht noch einmal.
- **Begrenzung auf 1 Stunde.** Liegt der letzte Scan mehr als eine Stunde zurück, wird das Fenster auf die letzte Stunde gekürzt. Die übersprungene Zeit steht in den Einstellungen unter „Lücke“. Zeilen gehen nicht stillschweigend verloren.
- **Ausschlussmuster** wirken vor der Gruppierung. Ein Fehler, dessen Meldung oder Stacktrace einen Eintrag enthält (ohne Unterscheidung von Groß- und Kleinschreibung), erzeugt kein Ereignis und zählt nicht.
- **Fehler des Scans.** Schlägt `docker compose logs` fehl, erscheint der Fehler unter „Letzter Fehler“ (höchstens 300 Zeichen). Es entstehen dann keine Ereignisse, und der Zeitpunkt des letzten Scans bleibt stehen. Der nächste erfolgreiche Scan setzt den Fehler zurück.
- **Gruppierung.** Gleiche Fehler werden über einen Fingerabdruck zusammengefasst: die Meldung bzw. der Titel, dazu der oberste Stack-Frame. Zehn gleiche Fehler ergeben also ein Ereignis mit Zähler 10 und nicht zehn Ereignisse.
- **Wann ein Bug entsteht:** Ein kritisches Ereignis (50 oder mehr Vorkommen pro Stunde) erzeugt sofort einen Bug mit Schwere „kritisch“. Sonst entsteht ein Bug, sobald ein Fehler in den letzten 24 Stunden mindestens 3 Mal aufgetreten ist.
- **Regression.** Tritt ein Fehler erneut auf, dessen Bug bereits „Behoben“ ist, wird dieser Bug wieder geöffnet.
- **Aufbewahrung.** Nach Ablauf der Frist löscht Dev Log Ereignisse, den stündlichen Verlauf und Deploy-Einträge, die älter als die eingestellten Tage sind.

**Anzeige in den Einstellungen „Betrieb“:** Zeitpunkt des letzten Scans, letzter Fehler, Anzahl erfasster Ereignisse mit Vorkommen und, falls vorhanden, die Lücke. Vor dem ersten Scan steht dort „Noch kein Scan“.

**Bug-Detail:** Der Abschnitt „Betrieb: Verlauf und Deploy-Verdacht“ zeigt:

- **Verlauf:** die Vorkommen je Stunde für die letzten 48 Stunden, mit Summe und Spitzenwert.
- **Ereignisse:** Quelle, Anzahl, Zeitpunkte des ersten und letzten Auftretens sowie das gekürzte, maskierte Beispiel und der Fingerabdruck.
- **Deploy-Verdacht:** Tritt ein Ereignis erstmals innerhalb von 30 Minuten nach einem Deploy auf, nennt Dev Log den Deploy-Zeitpunkt, die seit dem vorigen Deploy erledigten Aufträge und die zugehörigen Sprints. Ohne solchen Zusammenhang steht dort „Kein Deploy-Verdacht“.

**Hinweis:** Schlägt das Speichern einzelner Ereignisse teilweise fehl, bleibt der Zeitpunkt des letzten Scans stehen. Der nächste Scan zählt dann dieselben Zeilen erneut. Das ist das bisherige Verhalten.

## 5b. Betrieb: Rollback-Vorschlag nach einem Deploy

Tritt im Produktivbetrieb kurz nach einem Deploy ein kritischer Fehler auf, bietet das Bug-Detail an, den vorherigen Sprint-Tag wieder auszurollen. Der Rollback startet nur nach ausdrücklicher Bestätigung durch einen Menschen.

**Wann der Knopf erscheint:** Der Bug hat die Quelle „Betrieb“, die Schwere `critical` und mindestens ein Ereignis liegt höchstens 30 Minuten nach einem Deploy (`deploy_suspect`). Ohne diese Bedingung erscheint kein Vorschlag und kein Knopf.

**Was der Vorschlag nennt:** „Zuletzt ausgerollt“ mit dem Sprint-Tag des letzten Deploys und dessen Zeitpunkt, „davor“ den unmittelbar vorherigen Sprint-Tag. Es wird immer nur ein Schritt zurück angeboten.

**Knopf deaktiviert (mit Grund unter dem Knopf):**

- Der Sprint-Tag des letzten Deploys ist nicht bekannt.
- Es gibt keinen vorherigen Sprint-Tag.
- Es läuft bereits ein Deploy des Projekts.
- Für das Projekt sind keine Deploy-Befehle hinterlegt.
- Die Agents arbeiten im Projektordner. Ein Tag-Checkout würde deren Arbeit verändern. Der Grund nennt, einen eigenen Arbeitsordner für Agents einzustellen.
- Dem Benutzer fehlt die Berechtigung „Planung“. Ohne sie erscheint der Knopf deaktiviert mit dem Hinweis auf die fehlende Berechtigung.

**Bestätigung:** Der Knopf öffnet einen Dialog „Vorherigen Sprint-Tag wieder ausrollen“. Er nennt den Zieltag und den aktuell ausgerollten Tag und lässt sich mit „[Zieltag] ausrollen“ oder abbrechen beenden. Abbrechen löst nichts aus. Erst die Bestätigung schickt die Anforderung an den Server; sie enthält den Zieltag, und der Server prüft ihn erneut. Hat sich der Zieltag inzwischen geändert, weist der Server die Anforderung ab und bittet um neues Laden.

**Migrationen:** Der Vorschlag prüft, ob der Zieltag neuere Datenbank-Migrationen nicht kennt. Dann nennt der Dialog sie als Warnung. Die Datenbank wird **nicht** zurückgesetzt; ob ein Rollback mit diesem Datenbankstand funktioniert, entscheidet der Mensch. Lässt sich der Stand nicht prüfen, weist der Dialog ebenfalls darauf hin.

**Ablauf:** Nach der Bestätigung steht der Rollback als „Wartet auf den Worker“ im Protokoll. Der Worker startet ihn, sobald kein Agent und kein Deploy des Projekts läuft. Er checkt den Zieltag im Projektordner aus und rollt ihn über denselben Deploy-Pfad aus wie ein normaler „Live schalten“-Lauf. Die Oberfläche aktualisiert das Protokoll alle 5 Sekunden, solange ein Rollback offen ist.

**Protokoll im Bug-Detail:** Jeder Rollback steht mit Status (Wartet auf den Worker, Läuft …, Erfolgreich, Fehlgeschlagen), Ausgangs- und Zieltag, Zeitpunkt der Anforderung und des Abschlusses, dem Anfordernden und einem Ergebnistext. Ein fehlgeschlagener Rollback nennt den Grund im Ergebnistext, auch wenn kein einzelner Befehl gescheitert ist. Zusätzlich geht eine Push-Nachricht an das Projekt.

**Der Bug bleibt offen:** Nach einem Rollback ändert Dev Log den Bug nicht auf „Behoben“. Das entscheidet ein Mensch. Der Projektordner steht danach auf dem Zieltag, bis das nächste „Live schalten“ ihn wieder auf `main` zieht.

_[Printscreens für diesen Abschnitt fehlen noch: Knopf aktiv, Knopf deaktiviert mit Grund, Bestätigungsdialog mit Migrationswarnung, Rollback-Protokoll.]_

## 6. Git im Sprint

| Zeitpunkt                                         | Aktion                                                                                                                                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vor einem Sprint-Auftrag                          | Wechsel auf den Sprint-Branch aus `sprints.branch` (beim Start festgehalten, z. B. `sprint/<name>`; bei Bedarf von `main` angelegt).                                                          |
| Erster Agent, der Dateien ändert                  | Eigener **Auftrags-Branch** `auftrag/<id>-<titel>`, abgezweigt vom Sprint-Branch (sonst vom aktuellen Branch). Bei einem erneuten Versuch wird er fortgesetzt und der Basis-Stand eingemergt. |
| Auftrag erfolgreich (mit Auftrags-Branch)         | Commit auf dem Auftrags-Branch, Merge (`--no-ff`) in den Sprint-/Basis-Branch, Branch wird gelöscht. Scheitert der Merge, bleibt der Auftrag blockiert mit Meldung.                           |
| Auftrag fehlgeschlagen (mit Auftrags-Branch)      | Zwischenstand als WIP-Commit auf dem Auftrags-Branch, Rückkehr zur Basis; der nächste Versuch setzt dort fort.                                                                                |
| Auftrag im Sprint **erfolgreich**                 | Lokaler Commit auf dem Sprint-Branch, Conventional Commits: `feat(<Sprint>): <Titel>`, Bug-Aufträge `fix(...)`. Kein Push. Ohne Änderungen kein Commit.                                       |
| Auftrag **fehlgeschlagen**                        | Die vom Auftrag geschriebenen Dateien werden als Stash (`devlog-wip …`) geparkt und landen nicht im nächsten Commit; beim erneuten Versuch werden sie wiederhergestellt.                      |
| Sprint-Sicherung (Pfeil-hoch neben GitHub-Symbol) | Reständerungen committen, **Test-Gate** (Projekttests), nur bei grünen Tests Push des Sprint-Branches.                                                                                        |
| Sprint abgeschlossen                              | Zusätzlich Merge des Sprint-Branches nach `main` (`--no-ff`), erneutes Test-Gate, Push von `main` und Tag `sprint-<name>-<id>`. Bei Merge-Konflikten Abbruch mit Meldung.                     |
| Git Download (Pfeil-runter)                       | `git pull --ff-only origin <Branch>` im Projektordner; lokale Änderungen oder abweichende Historie brechen mit Meldung am Sprint ab.                                                          |

**Sprint-Branch beim Start festgehalten:** Der Branch eines Sprints wird einmal vergeben, sobald der Sprint den Status „Geplant“ verlässt, und steht in `sprints.branch`. Er heißt `sprint/<name zum Startzeitpunkt>`. Gibt es diesen Branch im Projekt schon bei einem anderen Sprint (zwei Sprints „Sprint 5“), kommen die ersten sechs Zeichen der Sprint-ID dazu (`sprint/sprint-5-1a2b3c`). Umbenennen per `PATCH /api/sprints/:id` bleibt erlaubt, ändert den Branch aber nicht. Früher wurde der Branch bei jedem Zugriff aus dem aktuellen Namen gebildet. Nach einer Umbenennung zweigte dann ein neuer Branch von `main` ab, beim Abschluss kam nur der Teil nach der Umbenennung nach `main`, und der Tag zeigte auf einen unvollständigen Stand. Die Spalte ist nicht per API schreibbar. Bestehende Sprints belegt die Migration 13 (`sprint-branch-beim-start-festhalten`) einmalig. Laufende Sprints behalten ihren heutigen Branch, bei gleichen Namen bekommen die übrigen die ID angehängt. Geplante Sprints erhalten ihren Branch erst beim Start. Fehlt beim Abschluss der Sprint-Branch, obwohl der Sprint erledigte Aufträge hat, gilt die Git-Sicherung als **gescheitert** statt „done“. Es wird dann nichts committet, getaggt oder nach `main` gemergt. Implementierung: `src/db/migrations.ts`, `sprintBranchOf` in `src/runner/git-sync/git-helpers.ts`, `pushSprint` in `src/runner/git-sync/sprint-sync.ts`.

**Eigener Agent-Worktree (z. B. AIdeation selbst):** Arbeiten die Agents in einem eigenen Worktree, ist `main` im Arbeitsordner der Menschen ausgecheckt. Die Git-Sicherung übernimmt den abgeschlossenen Sprint dort – aber nur, wenn im Ordner keine Änderungen offen sind und `main` ausgecheckt ist. Danach läuft das Test-Gate in diesem Ordner; ist es rot, wird der Merge mit `git reset --keep` zurückgenommen. Klappt alles, wird `main` gepusht (falls ein Repository hinterlegt ist; scheitert der Push, gilt die Sicherung als gescheitert). Ist der Ordner nicht sauber oder nicht auf `main`, steht die Sicherung auf **„Wartet auf Merge“** (`git_sync = 'awaiting_merge'`, nicht „done“). Der Sprint-Branch ist gesichert und getaggt, aber noch nicht in `main`. Die Meldung nennt den Schritt `git merge <Sprint-Branch>` im Ordner der Menschen. Sprints und die Lauf-Ansicht zeigen „Wartet auf Merge“, und der Autopilot meldet „finishing“ mit Begründung. Er startet keinen Sprint vom alten `main`, es wird nicht live geschaltet und kein Neustart angefordert, auch nicht mit `restart_after_sprint`. Bei jeder Git-Sicherung prüft der Worker mit `git merge-base --is-ancestor <Sprint-Stand> main` (bzw. dem neueren `origin/main`), ob der Sprint inzwischen in `main` ist. Exit 0 setzt „done“. Exit 1 heißt: weiter warten. Jeder andere Fehlercode (z. B. ein unbekannter Stand) setzt die Sicherung auf „gescheitert“, und der Autopilot pausiert. Auch vor jedem „done“ eines direkten Abschlusses prüft der Worker so, ob `main` den Sprint-Branch enthält. „Git-Sicherung“ lässt sich aus „Wartet auf Merge“ heraus erneut starten. Ein PATCH auf den abgeschlossenen Sprint (Name, Ziel) reiht nichts neu ein. Konflikte oder ein rotes Test-Gate beim Merge in den Ordner der Menschen bleiben **gescheitert**, der Autopilot pausiert. Nach dem Aufräumen „Git-Sicherung“ erneut starten. Migration 14 (`sprint-wartet-auf-merge`) erweitert `sprints_git_sync_check`. Implementierung: `pushSprint`, `mergeIntoCheckedOutMain` und `settleAwaitingMerge` in `src/runner/git-sync/sprint-sync.ts`, `mainContains` in `src/runner/git-sync/git-helpers.ts`, `autopilotGuard` in `src/api/sprint-planning.ts`. Nach einem erfolgreichen Merge wird mit „Nach dem Sprint-Abschluss AIdeation neu starten“ (`restart_after_sprint`) zusätzlich „AIdeation neu starten“ angefordert. Ab der Anforderung startet der Worker nichts Neues mehr (Drain: keine Aufträge, Chats, Tests, Jobs oder Git-Sicherungen) und bringt Laufendes zu Ende; ein Test-Gate, das der Neustart trotzdem beendet, wird wieder eingereiht statt als gescheitert zu gelten. Ein unterbrochener Auftrag (Neustart, Nutzungslimit, Sprint-Pause) sichert seinen Stand als WIP-Commit auf dem Auftrags-Branch und gibt den Arbeitsordner frei. Ohne offene Änderungen entsteht kein leerer Commit. Scheitert das Aufräumen (z. B. weil der Commit nicht geht), zeigt der Lauf einen gescheiterten Schritt „Arbeitsordner aufräumen (Git)“ mit der Meldung. Steht der Ordner noch sauber auf dem Branch eines anderen Auftrags (z. B. nach einem harten Abbruch), verlässt ihn ein Auftrag ohne Sprint und zweigt von `main` ab. Liegen dort noch offene Änderungen, startet er nicht, damit nichts verloren geht.

**Freigabe eines Auftrags im eigenen Agent-Worktree:** Ein Auftrag ohne Sprint (Basis `main`) landet nach dem Lauf in der Freigabe. Gibt ein Mensch ihn frei, merged AIdeation ihn in den Arbeitsordner der Menschen, auch wenn `main` dort ausgecheckt ist, und setzt ihn auf „Erledigt“. Dort gelten dieselben Sicherungen wie bei der Git-Sicherung: Liegen Änderungen offen, läuft ein Merge oder entsteht ein Konflikt, wird der Merge nicht erzwungen. Der Auftrag bleibt dann blockiert, sein Branch bleibt bestehen, und die Meldung nennt den Schritt „git merge <Branch>“ für Hand. Der Ordner der Menschen wird dabei nie mit `reset` oder einem Wechsel der Ausgangsbasis angefasst. Implementierung: `mergeApprovedBranch` in `src/runner/git-sync/order-branch.ts`; Regressionstest in `src/runner/git-sync.test.ts` (echter zweiter Worktree).

**Sprint-Sicherung wartet bei unterbrochenen Aufträgen:** Steht der Projektordner auf einem Auftrags-Branch (`auftrag/…`) und hat nicht committete Änderungen, wartet die Sicherung. Der Sprint bleibt auf `pending` (ausstehend). Es wird dann nichts ausgecheckt, nichts committet und nichts gepusht. Das gilt auch, wenn der unterbrochene Auftrag nur neue, noch nicht versionierte Dateien angelegt hat; sie gehören sonst ungeprüft in den Sprint-Branch und auf GitHub. Nicht gezählt werden die Berichte der Agents und die Agent-Ablage (`.dev-log/`, `docs/tests/`, `docs/risiken/`). Ein sauberer Auftrags-Branch ohne offene Änderungen hält die Sicherung nicht auf. Ist die Sicherung wegen eines Auftrags wartend, läuft sie am Ende desselben Durchlaufs erneut. Bleibt sie länger stehen, liegt meist ein unterbrochener Auftrag im Ordner: Den Auftrag erneut einplanen oder den Worker neu starten; beim Neustart sichert der Worker dessen Stand als WIP-Commit (siehe Laufzeit).

**Fortsetzen mit offenem Merge-Konflikt:** Steht der Arbeitsordner nach einem Abbruch (z. B. Worker-Neustart während des Entwicklers) noch auf dem Auftrags-Branch und ist ein Merge mit Konfliktmarkern offen, bleibt der Konflikt erhalten. Der nächste Agent, der Dateien ändert (meist der Entwickler), bekommt vor seiner Aufgabe den Abschnitt „Zuerst: Merge-Konflikte lösen“ mit den betroffenen Dateien. AIdeation bricht den Merge nicht ab und setzt ihn nicht zurück. Der Schritt besteht erst, wenn in den betroffenen Dateien keine Konfliktmarker mehr stehen. Scheitert die Prüfung selbst (git-Fehler), gilt der Konflikt als offen, nicht als gelöst. Nach dem Lösen läuft der Auftrag normal weiter. Implementierung: `src/runner/git-sync/order-branch.ts`, `src/runner/runner-steps.ts`. Printscreens gibt es dafür keine, weil sich in der Oberfläche nichts ändert.

### GitHub-Brücke (`github_mode`)

Projekteinstellung „GitHub-Brücke“ mit den Modi `aus` (Standard), `issues` und `issues+pr`; nur mit einem `git_remote` auf github.com. Dev Log speichert kein Token, sondern nutzt die Anmeldung der GitHub CLI des Worker-Benutzers (`gh auth login`). Der Worker prüft sie mit `gh auth status` und zeigt das Ergebnis in den Einstellungen; ohne Anmeldung bleibt der Modus wirkungslos und Git-Sicherung, Merge und Tag laufen wie oben. Im Modus `aus` ruft die Brücke `gh` nicht auf (das bestehende Warten auf die CI beim direkten Merge bleibt unverändert). Ausnahme: Steht noch ein Sprint mit geöffnetem Pull Request im Review (z. B. weil die Brücke nach dem Abschluss auf `aus` gestellt wurde), verfolgt der Worker ihn weiter wie im PR-Modus (Merge nach grüner CI bzw. Erkennen eines von Hand gemergten PR, Tag, `main` nachziehen, Live schalten, CI-Bug schliessen, Sprint `completed`). Der Issue-Import und die Rückmeldung bleiben aus.

- **Issue-Import** (`src/runner/github-sync.ts`, alle 5 Minuten im Worker-Takt): offene Issues mit Label `bug` bzw. `idea` werden zu Bug bzw. Idee mit `source='github'` und `external_ref='owner/repo#N'`; nach dem ersten Lauf nur die seit dem letzten Lauf geänderten (`--search updated:>=…`). Der eindeutige Index `(project_slug, external_ref)` verhindert Doppelimporte, ein Issue mit beiden Labels wird zum Bug. Bilder werden nie geladen, nur als Link übernommen. Der Issue-Text steht zwischen Markierungen für fremden Text; Auftragsautor, Schätzung und Entwickler bekommen dann einen Hinweis gegen Prompt-Injection.
- **Rückmeldung:** Wechselt der Stand eines importierten Eintrags (ausgearbeitet, im Sprint, blockiert, erledigt), schreibt Dev Log genau einen gebündelten Kommentar ins Issue und vermerkt den Stand in `github_synced_status`. Bei „erledigt“ wird das Issue mit Verweis auf Commit (`development_items.git_commit`) bzw. Sprint-Tag geschlossen.
- **PR-Modus** (`issues+pr`): Beim Sprint-Abschluss pusht `pushSprint` den Sprint-Branch und öffnet statt des direkten Merges `gh pr create` (Titel `Sprint: <Name>`, Text = Sprintbericht per `--body-file`). Der Sprint steht dann auf `review` mit `pr_url` und `ci_status`. `pollSprintReviews` fragt alle 2 Minuten `gh pr checks` ab: grün (und bei „Freigabe erforderlich“ nach Approve) → `gh pr merge --merge`, danach Tag auf dem gemergten `main`, Fast-Forward des lokalen `main` und Live schalten (`goLive`, Deploy und `production_deploys`). Live geschaltet wird aus dem Projektordner (`projects.repository`) in beiden Layouts: Mit eigenem Agent-Ordner wird `main` dort per Fast-Forward nachgezogen (bzw. eine losgelöste Vorschau auf `main` gesetzt); ohne eigenen Agent-Ordner wechselt der Projektordner vom Branch dieses Sprints auf `main`. Beides nur ohne offene Änderungen an versionierten Dateien; steht der Ordner auf einem fremden Branch oder hat offene Änderungen, bleibt er unberührt, es wird nicht deployt und der Sprint-Log nennt den Grund; rot → höchstens ein Bug je CI-Lauf mit gekürztem, maskiertem Auszug aus `gh run view --log-failed`. Ein von Hand gemergter Pull Request wird nur noch getaggt; ein ohne Merge geschlossener beendet den Sprint mit gescheiterter Git-Sicherung. Solange ein Sprint im Review ist, startet der Autopilot keinen neuen Sprint, und sein Status lässt sich nicht von Hand ändern (die API antwortet mit 409). Abschließen kann ihn nur der Worker nach dem Merge.
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
   Deployt wird nur, wenn der Projektordner sauber auf `main` steht (oder losgelöst genau auf `main`); sonst steht
   „Nicht deployt: …“ im Deploy-Status. Solange Aufträge auf die Review-Freigabe oder deren Merge warten, lässt sich
   der Sprint nicht abschliessen.
