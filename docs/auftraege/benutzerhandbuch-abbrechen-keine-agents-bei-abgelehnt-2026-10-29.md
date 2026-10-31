# Benutzerhandbuch: Nach „Abbrechen“ laufen keine Agents „Bei abgelehnt“ mehr

Gilt ab Sprint 28 (Auftrag f8dd63b7, Bugfix). Betrifft das Abbrechen eines laufenden Agents und den Sprint-Abbruch. Die Phase „Bei abgelehnt“ steht im Workflow-Panel unter „Agents“.

## 1. Was sich ändert

Bisher lief nach einem Abbruch der Auftrag so weiter, als wäre der Schritt gescheitert. Die Agents der Phase **„Bei abgelehnt“** starteten dann und verbrauchten Tokens. Sie konnten auch Dateien im Projekt ändern.

Jetzt gilt: Hast du einen laufenden Agent mit „■ Abbrechen“ gestoppt oder den Sprint abgebrochen, startet **kein weiterer Agent des Auftrags**. Auch die Agents „Bei abgelehnt“ laufen nicht. Die Phase „Bei abgeschlossen“ läuft ebenfalls nicht.

Eine neue Oberfläche gibt es dafür nicht. Die Änderung wirkt im Hintergrund. Deshalb gibt es hier keine Printscreens (siehe Abschnitt 6).

## 2. Bedingungen

### Wann du abbrechen kannst

Die Schaltfläche „■ Abbrechen“ steht in der Agentenliste nur dann, wenn alle drei Bedingungen zutreffen:

- Der Agent ist gerade aktiv.
- Der Agent läuft nicht manuell.
- Es ist nicht der Assistent.

Den Sprint-Abbruch löst du unverändert im Sprint aus.

### Was nach einem Abbruch nicht mehr passiert

| Schritt im Auftrag | Startet nach dem Abbruch? |
|---|---|
| Nachbesserung durch den Entwickler | Nein |
| Nächster Agent der Phase „Während“ oder „Danach“ | Nein |
| Agents der Phase „Bei abgelehnt“ | Nein |
| Agents der Phase „Bei abgeschlossen“ | Nein |

### Was unverändert bleibt

- Ein Abbruch plant den Auftrag **nicht** neu ein. Er gilt nicht als Unterbrechung.
- Ein Scheitern ohne Abbruch löst weiterhin „Bei abgelehnt“ aus. Das ist die Gegenprobe, die der Test prüft.
- Es entsteht kein Fehlerbericht zum Abbruch.
- Die Nachbesserung nach einem Fehler des Testers oder Reviewers ist nicht betroffen, solange kein Abbruch vorliegt.

## 3. Was du siehst

| Situation | Was passiert |
|---|---|
| Du klickst bei einem aktiven Agent auf „■ Abbrechen“ | Der Schritt endet als „Abgebrochen“. Danach startet kein Agent des Auftrags mehr. |
| Du brichst den Sprint ab, während ein Auftrag läuft | Der laufende Schritt endet. Kein Agent „Bei abgelehnt“ startet. |
| Ein Agent der Phase „Bei abgelehnt“ wird selbst abgebrochen | Die übrigen Agents dieser Phase starten ebenfalls nicht. |
| Ein Agent scheitert ohne Abbruch | Die Agents „Bei abgelehnt“ laufen wie bisher. |

Der Auftrag wird nicht als unterbrochen eingeplant. Welchen Status die Auftragsseite danach zeigt, habe ich nicht in der Oberfläche geprüft (siehe Abschnitt 7).

## 4. Beispiel

Ein Entwickler-Agent arbeitet seit zwanzig Minuten und hängt. Du klickst auf „■ Abbrechen“.

- Der Entwickler-Schritt endet als „Abgebrochen“.
- Der Auftrag führt keine Nachbesserung aus und startet keinen weiteren Agent.
- Die Agents der Phase „Bei abgelehnt“ laufen nicht. Sie verbrauchen also keine Tokens und ändern keine Dateien.

Vor der Änderung hätten die Agents „Bei abgelehnt“ trotzdem gestartet.

## 5. Fehlerbehebung

- **Nach „Abbrechen“ läuft noch ein Agent.** Prüfe, ob der Agent wirklich abgebrochen wurde. Ein manuell laufender Agent oder der Assistent hat keine Schaltfläche „Abbrechen“. Melde den Fall mit Auftrag und Uhrzeit.
- **Der Auftrag ist nach dem Abbruch nicht automatisch wieder eingeplant.** Das ist gewollt. Der Abbruch ist keine Unterbrechung. Was genau auf der Auftragsseite steht, prüfe dort selbst (siehe Abschnitt 3).
- **„Bei abgelehnt“ startet bei einem echten Fehler nicht.** Prüfe, ob der Schritt tatsächlich abgebrochen wurde. Ein normaler Fehlschlag ohne Abbruch startet die Agents weiterhin.

## 6. Printscreens

Keine. Die Änderung hat keine eigene Oberfläche. Der Abbruch zeigt dieselben Schaltflächen wie vorher. Für Aufnahmen bräuchte es eine laufende App mit Datenbank, einem Worker und einem laufenden Agent, den man abbricht. In dieser Sitzung lief keine App. Deshalb habe ich keine Bilder erfunden.

## 7. Grenzen dieses Kapitels

- Die Regressionstests stehen am Ende von `src/runner/runner.test.ts`: Abbruch über `cancel_requested` ohne Schritt der Phase „Bei abgelehnt“, Sprint-Abbruch während des Laufs ohne solchen Schritt und die Gegenprobe. Die Tests wurden in diesem Schritt nicht ausgeführt.
- Den genauen Status des Auftrags nach dem Abbruch habe ich nicht in der Oberfläche gesehen. Die Beschreibung stammt aus dem Quelltext.
- Die Bezeichnung „■ Abbrechen“ stammt aus `frontend/src/app/features/agents/agent-list.component.html`. Den Sprint-Abbruch habe ich nicht in der Oberfläche geprüft.

## 8. Für Entwickler

- `src/runner/runner-steps.ts`: `StepOutcome` hat das Feld `cancelled?: boolean`. `runStep` setzt es bei Abbruch. `interrupted` bleibt dabei `false`.
- `src/runner/runner.ts`: `runWorkItem` bricht bei `cancelled` ab. Die Beobachter von „Bei abgelehnt“ und „Bei abgeschlossen“ laufen nur bei `!cancelled`. Wird ein Beobachter abgebrochen, bricht die Schleife der Beobachter ab.
- Technische Details stehen in `docs/abbrechen-keine-agents-bei-abgelehnt-2026-10-29.md`. Die Ablaufbeschreibung steht in `docs/workflows.md` und im Kapitel zu Agents per Drag & Drop.

## Offen

- Die Tests in `src/runner/runner.test.ts` und `src/runner/runner-steps.test.ts` sind nicht ausgeführt.
- Die Zeile zu `cancelled` im Kapitel `docs/benutzerhandbuch-budget-pruefung-und-job-sperre.md` fehlt noch. Sie ist optional.
- Printscreens fehlen (siehe Abschnitt 6).
