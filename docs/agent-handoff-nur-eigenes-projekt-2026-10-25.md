# Review-Slot und Agent-Handoff nur mit IDs des eigenen Projekts

Auftrag d7054b90 (Bugfix, 25.10.2026). Gefunden im Code-Review vom 21.10.2026 (Stand `a4971e9`).

## Ursache

- `handoffTo` (Empfänger von Agent-Nachrichten) wurde in `PATCH /agents/:id` nur auf UUID-Form geprüft. Ein Agent konnte so an einen Agent eines fremden Projekts übergeben; Inhalte wären über Handoffs zwischen Mandanten gewandert.
- `developmentId` beim Review-Start: Der Bug-Wächter und der Entwickler haben nachgeprüft. Der Start (`src/api/review-routes.ts:241-251`) und der `requestSlot`-Aufruf bei der Freigabe (Zeile ~410) prüfen den Projektbezug bereits. Die Meldung ist dort 404, nicht 400. Dieser Teil des Berichts war damit kein Fehler im Code; `review-routes.ts` blieb unverändert.
- `POST /agents` schreibt `handoff_to` nicht; `PUT /system-agents/:role` hat kein `handoffTo`-Feld. Beide sind nicht betroffen.

## Umsetzung

- **`agentInProject`** (`src/api/agent-tasks.ts`) wird exportiert und wiederverwendet (bisher nur lokal für Agent-Aufgaben).
- **`PATCH /agents/:id`** (`src/api/agents.ts`): Ist `handoffTo` gesetzt, wird das Projekt des bearbeiteten Agents gelesen (wie bei `command`/`role`/`allowedCommands`) und der Empfänger gegen dieses Projekt geprüft. Fremde oder unbekannte ID: 400 „Der Empfänger gehört nicht zu diesem Projekt.“, nichts wird geschrieben. `null` hebt die feste Zuordnung auf und bleibt erlaubt.
- **Bestandsdaten:** Keine Migration oder Bereinigung nötig. `handoffTarget` (`src/core/workflow-phases.ts:54-70`) sucht den Empfänger nur unter den Agents des eigenen Workflows. Ein schon gespeicherter fremder `handoff_to` wird nicht gefunden, die Nachricht geht an den nächsten Agent.

## Geänderte Dateien

- `src/api/agent-tasks.ts` (Export von `agentInProject`)
- `src/api/agents.ts` (Prüfung im PATCH)
- `src/api/agents.test.ts`
- `docs/workflows.md` (Absatz „Nachrichten zwischen Agents“)

## Tests

- `src/api/agents.test.ts`: Die Attrappe hat jetzt zwei Projekte („demo“, „fremd“). Ein Agent aus „fremd“ wird mit 400 abgelehnt und nichts geschrieben, sowohl mit der Rolle `agents` als auch als Admin. Ein Agent aus dem eigenen Projekt und `null` werden gespeichert.
- Stand der Übergabe: Typecheck war grün. Die Tests ließen sich im Entwickler-Schritt nicht starten (Freigabe nötig). Bitte ohne Abdeckungs-Flags ausführen: `npx --no-install tsx --test src/api/agents.test.ts src/api/agent-tasks.test.ts`. Der 400-Test muss ohne die Prüfung scheitern.

## Worauf zu achten ist

- Die Prüfung gilt nur für `PATCH /agents/:id`. Wer künftig `handoff_to` an anderer Stelle schreibt, muss `agentInProject` ebenfalls nutzen.
- Der Fremdschlüssel allein reicht nicht, er prüft das Projekt nicht; eine Schemaänderung ist deshalb nicht vorgesehen.
- Für `developmentId` im Review-Container bleibt es bei 404 statt dem im Auftrag genannten 400.
