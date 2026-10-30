# Benutzerhandbuch: Workflow-Reihenfolge nach Einstellungen ausführen

Dieses Kapitel beschreibt, wie der Worker die Agents eines Projekts ausführt, und was passiert, wenn du unter „Agents“ Phase, Reihenfolge oder Aktiv-Status änderst. Auftrag 2dc56111 (Sprint 28). Die Entwicklerdoku steht in [`workflow-reihenfolge-nach-einstellungen-ausfuehren-2026-10-29.md`](workflow-reihenfolge-nach-einstellungen-ausfuehren-2026-10-29.md).

> **Printscreens: keine.** In dieser Sitzung lief weder die App noch eine Datenbank, und ein Browser stand nicht bereit. Die Beschreibung stammt aus dem Quelltext (`src/runner/runner-selection.ts`, `src/api/agents.ts`, `src/api/workflow.ts`) und aus den Tests in `src/runner/runner-steps.test.ts` und `src/api/app.test.ts`. Die Aufnahmen stehen unter „Noch aufzunehmen“ am Ende.

---

## 1. Was sich ändert

Bisher gab es zwei Stellen, an denen Phase und Reihenfolge eines Agents standen: am Agent selbst und in den Workflow-Schritten (Agents → Workflow). Der Worker las aber bei Projekten mit Schritten nur die Schritte. Änderungen unter „Agents“ wirkten dort nicht, obwohl die Oberfläche sie anzeigte.

Jetzt gilt eine einzige Regel:

- **Projekt mit Workflow-Schritten:** Die Schritte sind die einzige Quelle für Phase, Reihenfolge und Anweisung. Der Worker führt genau das aus, was das Panel „Workflow“ zeigt.
- **Projekt ohne Workflow-Schritte:** Es gilt der bisherige Ablauf aus Phase, Position und Aktiv-Status am Agent.

Die Agent-Wege schreiben deshalb in die Schritte mit:

| Aktion unter „Agents“ | Was jetzt passiert |
| --- | --- |
| **Agent anlegen** | Ist das Projekt schon im Workflow, hängt der neue Agent einen Schritt ans Ende seiner Phase. Der Agent läuft dann auch. Vorher lief ein neuer Agent in einem Projekt mit Schritten gar nicht. |
| **Standard-Reviewer** | Wird er automatisch ergänzt, bekommt er ebenfalls einen Schritt ans Ende von „Danach“, wenn das Projekt Schritte hat. |
| **↑ / ↓ in der Agent-Reihenfolge** | Die neue Reihenfolge und Phase gelten auch für die Schritte des Agents. |
| **Phase des Agents ändern** | Alle Schritte des Agents, die in einer anderen Phase stehen, wechseln mit in die neue Phase. Sie landen am Ende dieser Phase, in der bisherigen Reihenfolge. |

In der Agent-Liste zeigt jeder Agent Phase und Position seines **ersten** Schritts. Das ist dieselbe Stelle, an der der Worker ihn ausführt.

## 2. Bedienung

### 2.1 Reihenfolge ändern

1. Öffne „Agents“ des Projekts.
2. Verschiebe den Agent mit ↑ oder ↓ oder ändere seine Phase in den Agent-Einstellungen.
3. Die Änderung wird gespeichert. Der nächste Worker-Durchgang führt den Agent in der neuen Phase und Reihenfolge aus.

Änderst du die Reihenfolge im Panel „Workflow“, gilt sie ebenfalls ab dem nächsten Durchgang. Die Agent-Liste zeigt danach dieselbe Reihenfolge.

### 2.2 Agent pausieren oder deaktivieren

- **Schritt pausieren** (im Workflow-Panel): Der Einsatz bleibt stehen, läuft aber nicht. Er wird nur an dieser Stelle übersprungen. Der Agent selbst bleibt aktiv und läuft an seinen anderen Schritten.
- **Agent deaktivieren** (in den Agent-Einstellungen): Der Agent läuft in keinem seiner Schritte, auch nicht in denen, die nicht pausiert sind.

Wieder aktiviert läuft der Agent ab dem nächsten Durchgang an seinen Schritten, sofern sie nicht pausiert sind.

## 3. Bedingungen

| Fall | Was passiert |
| --- | --- |
| **Projekt mit Workflow-Schritten** | Nur die Schritte zählen. Phase, Position und Anweisung am Agent werden für den Worker nicht mehr gelesen. |
| **Projekt ohne Workflow-Schritte** | Phase und Position am Agent bestimmen den Ablauf. Am Agent deaktivierte Agents laufen nicht. Das Verhalten ist unverändert. |
| **Schritt pausiert** | Der Schritt wird nicht ausgeführt. |
| **Agent deaktiviert** | Der Agent wird in keinem Schritt ausgeführt, auch wenn ein Schritt aktiv ist. |
| **Agent in mehreren Phasen** | Jeder Schritt wird für sich ausgeführt. Ein Phasenwechsel verschiebt nur die Schritte, die in einer anderen Phase stehen. |
| **Laufender Auftrag** | Der Lauf arbeitet mit dem Ablauf, der zu seinem Start galt. Die Änderung wirkt erst ab dem nächsten Durchgang (siehe [`benutzerhandbuch-workflow-umbau-waehrend-lauf.md`](benutzerhandbuch-workflow-umbau-waehrend-lauf.md)). |
| **Projekt mit Schritten, in dem Agent-Felder und Schritte früher auseinanderliefen** | Die Schritte bleiben erhalten und gelten. Die Phase und Position am Agent werden nicht mehr herangezogen. Eine Migration gibt es nicht. Prüfe deshalb im Panel „Workflow“, ob der Ablauf stimmt, bevor du den nächsten Auftrag startest. |

## 4. Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| Ein Agent wird nicht ausgeführt, obwohl er in den Agent-Einstellungen aktiv ist | Prüfe im Panel „Workflow“, ob sein Schritt pausiert ist. Pausierte Schritte laufen nicht. Ist der Agent selbst deaktiviert, läuft er in keinem Schritt. |
| Die Agent-Liste zeigt eine Phase, die der Worker nicht ausführt | Sollte nach dieser Änderung nicht mehr vorkommen. Die Liste zeigt die Phase des ersten Schritts. Lade die Seite neu. Bleibt die Abweichung, bitte mit Projekt, Agent und Uhrzeit melden. |
| Ein neu angelegter Agent läuft nicht | Prüfe, ob er im Panel „Workflow“ steht. In einem Projekt mit Schritten erzeugt das Anlegen einen Schritt. Fehlt er, lade die Seite neu und prüfe die Fehlermeldung beim Anlegen. |
| Eine Änderung der Reihenfolge ist nach dem Lauf noch nicht wirksam | Der laufende Auftrag arbeitet mit dem alten Ablauf weiter. Die Änderung gilt ab dem nächsten Durchgang. |

## 5. Grenzen dieses Kapitels

- Die Tests liegen in `src/runner/runner-steps.test.ts` (neue Reihenfolge, pausierter Schritt, deaktivierter Agent mit und ohne Schritte, Schritt nach einem Phasenwechsel, Projekt ohne Schritte) und in `src/api/app.test.ts` (Anlegen erzeugt einen Schritt, Reihenfolge-Route und Phasenwechsel schreiben in die Schritte). Ich habe sie in dieser Sitzung nicht ausgeführt. Das Ergebnis des Entwicklers lag mir nur als Zusammenfassung vor.
- Der Oberflächentest `e2e/full-ui.check.ts` ist nicht gelaufen. Der Tester soll ihn nachholen (Agents anlegen, ↑/↓, Ziehen in eine andere Phase).
- Protokolliert wird nicht, wenn ein Schritt übersprungen wird (eigener Auftrag, falls gewünscht).
- Die Änderung betrifft nur Phase, Reihenfolge und Aktiv-Status. Budget, Modell-Routing, Sprintplanung und Autopilot sind nicht berührt.

## 6. Noch aufzunehmen

Diese Aufnahmen fehlen. Sie brauchen eine laufende App mit Testdaten und einem Browser:

1. Agent-Liste eines Projekts mit Schritten, Pfeile ↑/↓ und Phase sichtbar.
2. Panel „Workflow“ mit einem pausierten Schritt („Pausiert“).
3. Agent-Einstellungen mit deaktiviertem Agent.
4. Neu angelegter Agent in einem Projekt mit Schritten, mit dem Schritt im Panel „Workflow“.

## 7. Verweise

- [`workflow-reihenfolge-nach-einstellungen-ausfuehren-2026-10-29.md`](workflow-reihenfolge-nach-einstellungen-ausfuehren-2026-10-29.md) (Entwicklerdoku zu diesem Auftrag)
- [`benutzerhandbuch-workflow-umbau-waehrend-lauf.md`](benutzerhandbuch-workflow-umbau-waehrend-lauf.md) (Umbau während eines laufenden Auftrags)
- [`agenten-per-drag-and-drop-zwischen-phasen-2026-10-28.md`](agenten-per-drag-and-drop-zwischen-phasen-2026-10-28.md) (Verschieben von Schritten im Panel)
- [`workflows.md`](workflows.md), Abschnitt 4a (Workflow)
