# Visionär folgt der CLI-Wahl in den Einstellungen

Auftrag 6151b2c4 (Bugfix, Sprint 23).

## Problem

In Einstellungen → System-Agents war für den Visionär `claude --model opus …` gewählt. `runAuthorAgent` (`src/agent/requirements.ts`) nahm aber nur den Befehl eines Projekt-Agents mit Rolle `visionary`, sonst `dashboardCommand`, und das kannte nur `assistant`, `analyst` und `routine`. Ohne eigenen Visionär-Agent und ohne `DEV_LOG_AGENT_COMMAND` fiel der Lauf still auf Ollama (`qwen3.5:27b`) zurück. Beobachtet bei TowerField: 18 Visionär-Läufe mit 0,00 $ seit 24.10.

## Umsetzung

- `src/agent/system-agents.ts`: `dashboardCommand` kennt jetzt auch `visionary` und liefert die gewählte CLI, mit `readOnlyCommand` ohne Rechte-Flags. Dazu die gemeinsame Auswahllogik (`settingCommand`) und `systemAgentUsage`, die für die Anzeige ausrechnet, was ein Lauf nimmt.
- `src/agent/requirements.ts`: `runAuthorAgent` nutzt diese Auswahl statt einer eigenen Kopie. Der Visionär bleibt lesend: Datei-Werkzeuge und Shell sind gesperrt wie bisher.
- `src/api/agents.ts`: `GET /system-agents` liefert pro System-Agent das Feld `usage`; `PUT /system-agents/:role` gibt die neue Anzeige mit zurück. Vom Ersatzbefehl `DEV_LOG_AGENT_COMMAND` steht nur der Programmname in `app_settings.agent_fallback_command` (Argumente könnten Schlüssel enthalten). Der Worker schreibt ihn beim Start.
- Frontend (`features/agents/agents.component.ts/.html`): Unter Agents → System steht pro System-Agent „Verwendet: …“ (z. B. „CLI: Claude Opus“, „CLI: Claude (aus DEV_LOG_AGENT_COMMAND)“ oder „Lokales Modell: …“).

Reihenfolge für Assistent, Problemanalyse und Visionär: eigener Agent der Rolle im Projekt → Wahl in den Einstellungen → `DEV_LOG_AGENT_COMMAND` → Ollama. Die Schnellschätzung kennt nur die Einstellung und Ollama.

## Worauf zu achten ist

- `visionary` ist bewusst nicht in `RESTRICTED_ROLES`: Es gibt für den Visionär keinen Schalter für volle Werkzeugrechte. `author` bleibt ausgenommen.
- Scheitert eine gewählte CLI (fehlt, Monatslimit erreicht), endet der Lauf mit deren Fehlermeldung. Es gibt keinen stillen Wechsel auf Ollama mehr. Bei Fehlern zuerst das Limit der Claude-CLI prüfen, bevor am Code gesucht wird.
- Anzeige und Lauf müssen dieselbe Auswahllogik nutzen. Neue Rollen oder Quellen deshalb nur in `system-agents.ts` ergänzen. Die Anzeige ist nach dem Speichern aktuell; den Ersatzbefehl veröffentlicht der Worker nur beim Start, eine Änderung der Umgebungsvariable zeigt sich erst nach einem Neustart.
- Ein eigener Agent der Rolle im Projekt geht der Einstellung vor; die Anzeige weist darauf hin.
- Die 18 früheren Läufe sind nicht nachträglich korrigiert.

## Tests

- `src/agent/requirements.test.ts`: Einstellung `claude …` für `visionary`, kein Projekt-Agent, kein `DEV_LOG_AGENT_COMMAND` → der Executor bekommt den Claude-Befehl, ohne Rechte-Flags und mit gesperrten Schreib-Werkzeugen.
- `src/agent/system-agents.test.ts`: gemeinsame Auswahllogik, Anzeige (`usage`) und Programmname.
- Von der Dokumentation nicht erneut ausgeführt.

## Geänderte Dateien

- `src/agent/system-agents.ts`, `src/agent/requirements.ts`, `src/api/agents.ts`
- `src/agent/requirements.test.ts`, `src/agent/system-agents.test.ts`
- `frontend/src/app/features/agents/agents.component.ts`, `agents.component.html`
- `docs/agents-und-rechte.md` (Abschnitte „CLI-Wahl gilt auch für den Visionär“ und „Anzeige ‚Verwendet‘“)

## Offen für das Benutzerhandbuch

Unter Agents → System die Zeile „Verwendet: …“ beschreiben; der Visionär folgt der CLI-Wahl und bleibt lesend; keine Schalter für volle Werkzeugrechte beim Visionär; kein stiller Wechsel auf Ollama bei CLI-Fehlern.
