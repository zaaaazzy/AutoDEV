# Workflow-Reihenfolge nach Einstellungen ausführen

Auftrag 2dc56111 (Sichtung: Phase und Position lagen an zwei Stellen).

## Ursache (bestätigt)

- Der Worker (`loadWorkflow`, `src/runner/runner-selection.ts`) nutzt bei Projekten mit Workflow-Schritten nur `workflow_steps` (Phase, Position, Pause, Anweisung). Am Agent wirkte nur `enabled`.
- Die Reihenfolge-Route (`POST …/agents/order`) und der Phasenwechsel in `PATCH /agents/:id` (`src/api/agents.ts`) schrieben nur `agents.phase` und `agents.position`. Beim Anlegen entstand kein Schritt.
- Folge: Die Agent-Ansicht zeigte eine Reihenfolge oder Phase, die der Worker ignorierte. Ein neu angelegter Agent (und der automatisch ergänzte Reviewer) lief in Projekten mit Schritten gar nicht.

## Umsetzung

- Quelle: Hat ein Projekt Schritte, gelten nur diese. Neu ist `workflowFromRows(steps, agents)`: pausierte Schritte und deaktivierte Agenten (in jedem ihrer Schritte) werden ausgelassen; ohne Schritte gilt der Ablauf aus Phase, Position und `enabled` am Agent.
- Schreibwege in `src/api/agents.ts`:
  - Anlegen und `ensureReviewer`: `appendAgentStep` hängt einen Schritt ans Ende der Phase, aber nur, wenn das Projekt schon Schritte hat. Die Antwort von `POST …/agents` enthält zusätzlich `step`.
  - Reihenfolge-Route: setzt Position und Phase auch an den Schritten der betroffenen Agents.
  - Phasenwechsel (`PATCH`): `moveAgentSteps` verschiebt die Schritte in anderen Phasen ans Ende der neuen Phase.
- Anzeige: `GET …/agents` liefert bei vorhandenen Schritten Phase und Position des ersten Schritts (so, wie der Worker den Agent ausführt).
- Oberfläche: `workflow-steps.component.ts` nutzt den vom Server angelegten Schritt, statt einen zweiten anzulegen, und öffnet direkt die Anweisung.
- Rechte unverändert: Die Admin-Prüfung für `command` und die Rollenprüfungen der Routen wurden nicht angefasst.
- Laufende Läufe bleiben unberührt; die Änderung gilt ab dem nächsten Durchgang.

## Geänderte Dateien

- `src/runner/runner-selection.ts`
- `src/api/agents.ts`
- `frontend/src/app/features/agents/workflow-steps.component.ts`
- `src/runner/runner-steps.test.ts`: Tests zu neuer Reihenfolge, pausiertem Schritt, deaktiviertem Agent (mit und ohne Schritte), Phasenwechsel und Projekt ohne Schritte
- `src/api/app.test.ts`: Anlegen erzeugt Schritt, Reihenfolge-Route und Phasenwechsel schreiben in die Schritte, Agent-GET liefert Phase und Position des ersten Schritts; der Test zum Agent-Befehl wurde angepasst (letzte Abfrage ist jetzt das Anlegen des Schritts)
- `docs/workflows.md` Abschnitt 4a

Keine Migration und keine Schemaänderung. Bestandsprojekte, deren Schritte und Agent-Felder schon abweichen, behalten ihre Schritte (das war die Quelle des Workers); die Agent-Felder werden dort nicht mehr herangezogen.

## Sprint

| Auftrag | Titel | Zustand |
|---|---|---|
| 2dc56111 | Workflow-Reihenfolge nach Einstellungen ausführen | umgesetzt (Entwickler), dokumentiert; Test der Oberfläche (`e2e/full-ui.check.ts`) beim Tester angefragt |

## Anfrage / TODO

- Tester: `e2e/full-ui.check.ts` (Agents anlegen, ↑/↓, Ziehen in eine andere Phase) einmal laufen lassen; dort wurde nichts angepasst.
- Offen (eigener Auftrag, falls gewünscht): Protokollierung übersprungener Schritte.

## Technische Dokumentation

- `WorkflowRow = WorkflowAgent & { enabled; agentEnabled? }`: Eingabe von `workflowFromRows`. Schritt-Zeilen tragen `enabled` (Schritt) und `agentEnabled`; Agent-Zeilen nur `enabled`.
- `appendAgentStep` ist ein einzelnes `INSERT … SELECT … WHERE EXISTS`; ohne Schritte im Projekt legt es nichts an, damit ein Altprojekt nicht halb umgestellt wird.
- Neue Wege, die Phase, Position oder Aktiv-Status eines Agents ändern, müssen ebenfalls in `workflow_steps` schreiben.

## Worauf zu achten ist

- Die Agent-Felder `phase`/`position` sind bei Projekten mit Schritten nur noch Rückfallwerte; maßgeblich sind die Schritte.
- Ein Agent, der in mehreren Phasen vorkommt, wechselt bei `PATCH phase` nur mit seinen Schritten in anderen Phasen; alle landen am Ende der neuen Phase.
- Die Testsuite wurde in diesem Schritt nicht neu ausgeführt; das Ergebnis des Entwicklers lag mir nur als Zusammenfassung vor.
