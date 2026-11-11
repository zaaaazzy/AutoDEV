# Neueste Claude-Modelle in den Einstellungen, inkl. Fable (2026-11-11)

## Was sich ändert

In allen Modell-Auswahlen der Oberfläche (Agents → Workflow-Agent bearbeiten, Agents → System-Agents, Workflow-Schritte,
Einrichtungsassistent → „Wer arbeitet für dich?“) gibt es jetzt vier Claude-Vorgaben:

| Vorgabe           | Befehl                                                     | Kosten |
| ----------------- | ---------------------------------------------------------- | ------ |
| Claude Haiku 5.5  | `claude --model haiku --permission-mode acceptEdits -p …`  | $      |
| Claude Sonnet 5.5 | `claude --model sonnet --permission-mode acceptEdits -p …` | $$     |
| Claude Opus 5.5   | `claude --model opus --permission-mode acceptEdits -p …`   | $$$    |
| Claude Fable 5.1  | `claude --model fable --permission-mode acceptEdits -p …`  | $$$$   |

Die Claude-CLI nimmt für die Aliase `haiku`, `sonnet`, `opus` und `fable` immer die neueste Version der jeweiligen
Reihe. Geprüft am 2026-11-11 mit Claude Code 2.1.302: `fable` → `claude-fable-5-1`, `opus` → `claude-opus-5-5`,
`sonnet` → `claude-sonnet-5-5`, `haiku` → `claude-haiku-5-5`. Die Versionsnummer im Label ist dieser Stand und wird
an einer Stelle nachgezogen (`CLAUDE_MODELS` in `frontend/src/app/features/agents/agent-options.ts`), wenn die CLI
eine neuere Generation liefert; Vorgaben und Einrichtungsassistent lesen beide daraus, der gespeicherte Befehl
ändert sich dadurch nicht.

Fable ist die teuerste Stufe (laut Anthropic-Preisliste über Opus, Abrechnung beim Anbieter) und bekommt darum die neue
Kostenstufe `$$$$`.

## Betroffene Dateien

- `frontend/src/app/features/agents/agent-options.ts`: `CLAUDE_MODELS` (Alias, Label mit Version, Kurzbeschreibung,
  Kostenstufe) als einzige Liste der Claude-Modelle; daraus die Vorgaben `claude-<alias>` mit der gemeinsamen
  Befehlsvorlage `claudeCommand`, neu `claude-fable` mit Kostenstufe 4.
- `frontend/src/app/features/projects/project-wizard.component.ts`: Modellliste des Anbieters Claude im
  Einrichtungsassistenten (`PROVIDERS`) wird aus `CLAUDE_MODELS` gebaut (Label „– Kurzbeschreibung“).
- Backend unverändert: `agentCommand` in `src/api/setup.ts` reicht die Modellangabe unverändert an `claude --model`
  weiter; der Verbindungstest (`testAgent` in `src/setup/setup-jobs.ts`) ebenso.

## Tests

- `frontend/src/app/features/agents/model-presets.spec.ts`: je Claude-Modell Vorgabe, Label, Kostenstufe und
  Erkennung des gespeicherten Befehls; Reihenfolge und Stufe von Fable.
- `src/setup/setup.test.ts`: `agentCommand('claude', 'fable')`.
