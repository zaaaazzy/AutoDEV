# Benutzerhandbuch: CLI-Wahl für den Visionär und die Anzeige „Verwendet“

Auftrag 6151b2c4 (Bugfix, Sprint 23). Dieses Kapitel beschreibt, welche CLI der Visionär und die anderen System-Agents nehmen, wie du das unter Agents → System siehst und was passiert, wenn die gewählte CLI nicht läuft.

> **Was sich geändert hat:** Vorher hat der Visionär ohne eigenen Visionär-Agent im Projekt und ohne `DEV_LOG_AGENT_COMMAND` still auf das lokale Modell Ollama (`qwen3.5:27b`) gewechselt, auch wenn in den Einstellungen Claude gewählt war. Jetzt gilt die Wahl aus den Einstellungen. Neu ist außerdem die Zeile „Verwendet: …“ unter jedem System-Agent.
>
> **Printscreens:** keine. Die App lief für diesen Auftrag nicht, und ein Browser-Lauf ist nicht erfolgt. Die Beschreibung unten stammt aus dem Code (`src/agent/system-agents.ts`, `src/agent/requirements.ts`, `frontend/src/app/features/agents/agents.component.html` und `.ts`) und aus `docs/agents-und-rechte.md`.

---

## 1. Wo du das findest

Agents → **System**. Jeder der vier System-Agents hat eine Zeile mit seiner Auswahl:

| System-Agent | Rolle | Was er tut |
| --- | --- | --- |
| Dashboard-Assistent | `assistant` | Beantwortet Chat-Fragen, prüft Dienste, löst Probleme im Projektumfang. |
| Problemanalyse | `analyst` | Analysiert blockierte Aufträge. |
| Schnellschätzung | `author` | Schätzt Aufwand und Nutzen neuer Ideen. |
| Visionär | `visionary` | Analysiert das Projekt nur lesend und schlägt Erweiterungsideen vor. |

Klappst du einen System-Agent auf, siehst du:

1. **Modell / Dienst:** Auswahl aus den installierten Ollama-Modellen, aus „Externe CLI (Anmeldung dort)“ oder „Eigener Befehl“, falls ein eigener Befehl gespeichert ist.
2. **Verwendet:** Was ein Lauf tatsächlich nimmt. Dieser Satz ist die eigentliche Neuerung.
3. Bei der Problemanalyse, der Schnellschätzung und dem Assistenten (nur wenn eine CLI gewählt ist) den Schalter „Volle Werkzeugrechte der CLI erlauben“. Der Visionär hat **keinen** Schalter (siehe Abschnitt 4).

In der Tabelle selbst steht in der Spalte „Modell“ ebenfalls, was der Lauf nimmt, und nicht nur die Einstellung.

---

## 2. Die Zeile „Verwendet“

Die Zeile zeigt eine von drei Formen:

| Anzeige | Bedeutung |
| --- | --- |
| `Verwendet: CLI: Claude Opus` | Die Wahl in den Einstellungen wird genommen. Der Lauf startet die CLI. |
| `Verwendet: CLI: Claude (aus DEV_LOG_AGENT_COMMAND)` | Keine Wahl in den Einstellungen. Der Lauf nimmt die Umgebungsvariable `DEV_LOG_AGENT_COMMAND` des Workers. |
| `Verwendet: Lokales Modell: qwen3.5:27b` | Weder Einstellung noch Umgebungsvariable. Der Lauf nimmt das lokale Modell über Ollama. |

Zusätze hinter der Zeile:

- **„· nur lesend“** erscheint beim Visionär, wenn die CLI gewählt ist. Er darf dann nur lesen.
- **„· ein eigener Agent dieser Rolle im Projekt geht vor.“** steht bei allen System-Agents außer der Schnellschätzung. Der Hinweis ist allgemein gehalten. Er zeigt nicht an, ob im Projekt tatsächlich ein Agent mit dieser Rolle existiert. Hast du einen, gilt er vor allem anderen (siehe Abschnitt 3).

Die Anzeige ist nach dem Speichern sofort aktuell. Wenn du die Wahl änderst, springt die Zeile um, ohne dass du die Seite neu laden musst.

**Achtung bei `DEV_LOG_AGENT_COMMAND`:** Der Worker veröffentlicht den Programmnamen nur beim Start. Ändert jemand die Umgebungsvariable, zeigt die Zeile den neuen Wert erst nach einem Neustart des Workers. Angezeigt wird nur der Programmname, zum Beispiel `claude`, ohne Argumente. Argumente könnten Schlüssel enthalten und stehen deshalb nicht in der Oberfläche.

---

## 3. Welche Quelle gewinnt

Für Assistent, Problemanalyse und Visionär gilt diese Reihenfolge:

1. **Eigener Agent der Rolle im Projekt** (Agents → Workflow, z. B. ein Agent mit Rolle „Visionär“ und eigenem Befehl). Er geht allen anderen Quellen vor.
2. **Die Wahl in den Einstellungen** unter Agents → System.
3. **`DEV_LOG_AGENT_COMMAND`** des Workers.
4. **Lokales Modell** über Ollama.

Die **Schnellschätzung** hat die Stufe 3 nicht. Sie nimmt nur die Einstellung oder Ollama.

Die Zeile „Verwendet“ rechnet genau diese Reihenfolge nach, ohne den eigenen Projekt-Agent. Der Hinweis „ein eigener Agent … geht vor“ weist darauf hin.

---

## 4. Der Visionär bleibt lesend

Die CLI-Wahl gilt auch für den Visionär. Er bekommt die Befehlszeile aus den Einstellungen, aber ohne Rechte:

- Rechte-Flags wie `--permission-mode`, `--dangerously-skip-permissions` oder `--allow-all-tools` werden **immer** entfernt. Die Funktion dafür ist `readOnlyCommand`.
- Im Lauf sind `Write`, `Edit`, `MultiEdit`, `NotebookEdit` und `Bash` gesperrt. Das gilt auch, wenn in der Einstellung oder am Befehl Rechte stehen.
- Es gibt **keinen** Schalter „Volle Werkzeugrechte der CLI erlauben“ für den Visionär. Die Rolle steht bewusst nicht in der Liste der eingeschränkten Rollen.

Das Ergebnis des Visionärs sind `@@IDEA`-Zeilen. Ideen legt er nicht selbst an, der Worker legt sie aus den Zeilen an.

---

## 5. Was passiert, wenn die CLI nicht läuft

Scheitert die gewählte CLI, etwa weil sie nicht installiert ist oder das **Monatslimit** der Claude-CLI erreicht ist, endet der Lauf mit der Fehlermeldung der CLI.

Es gibt **keinen stillen Wechsel auf Ollama** mehr. Die Fehlermeldung der CLI steht im Lauf; wo genau sie in der Oberfläche erscheint, ist in diesem Kapitel nicht geprüft.

**Bei Fehlern zuerst prüfen:**

1. Ist das Monatslimit der Claude-CLI erreicht? Die Meldung lautet dann etwa „You've hit your monthly spend limit“. Das ist kein Codefehler.
2. Ist die CLI auf dem Worker-Rechner installiert und angemeldet?
3. Steht unter „Verwendet“ die CLI, die du erwartest?

Bis zur Änderung wurden Visionär-Läufe ohne Projekt-Agent still über Ollama gefahren. Bei TowerField sind es 18 Läufe seit dem 24.10. mit 0,00 $. Diese Läufe sind **nicht** korrigiert. Ob sie erneut laufen sollen, entscheidet der Betrieb.

---

## 6. Schnellschätzung und Assistent

- **Schnellschätzung** (`author`): Die Wahl gilt nur für die Schätzung neuer Ideen. Der Auftragsautor, der Anforderungen schreibt, nimmt sie nicht. Sie fällt ohne Wahl direkt auf Ollama zurück und nimmt `DEV_LOG_AGENT_COMMAND` nicht.
- **Assistent** (`assistant`): Nimmt die CLI aus den Einstellungen mit allen Optionen des Presets. Der Schalter „Volle Werkzeugrechte“ entscheidet nur, ob die Rechte-Flags des Presets bleiben.
- **Problemanalyse** (`analyst`): Nimmt die CLI nur lesend, außer der Schalter „Volle Werkzeugrechte“ ist an.

---

## 7. Fehlerbehebung

- **„Verwendet“ zeigt Ollama, obwohl ich Claude gewählt habe.** Prüfe, ob im Projekt ein eigener Agent der Rolle existiert; der geht vor. Prüfe auch, ob die Einstellung gespeichert wurde (Seite neu laden). Bei der Schnellschätzung gilt `DEV_LOG_AGENT_COMMAND` nicht, dort fällt die Auswahl auf Ollama zurück.
- **„Verwendet“ zeigt `aus DEV_LOG_AGENT_COMMAND`, obwohl ich die Variable geändert habe.** Der Worker muss neu gestartet werden, damit er den Programmnamen neu veröffentlicht.
- **Lauf endet mit einer CLI-Meldung.** Siehe Abschnitt 5. Das Limit prüfen, bevor am Code gesucht wird.

---

## 8. Für Entwickler

- Die Auswahl steht nur in `src/agent/system-agents.ts`: `settingCommand`, `dashboardCommand`, `systemAgentUsage`. `runAuthorAgent` in `src/agent/requirements.ts` und die Anzeige nutzen diese Funktionen. Neue Rollen oder Quellen deshalb nur dort ergänzen, sonst weichen Anzeige und Lauf voneinander ab.
- `GET /system-agents` liefert pro System-Agent das Feld `usage`. `PUT /system-agents/:role` gibt die neue Anzeige gleich mit zurück.
- Tests: `src/agent/requirements.test.ts` (Visionär mit Claude-Einstellung, ohne Projekt-Agent, ohne `DEV_LOG_AGENT_COMMAND`: der Executor bekommt den Claude-Befehl ohne Rechte-Flags und mit gesperrten Schreib-Werkzeugen) und `src/agent/system-agents.test.ts` (Auswahllogik, Anzeige, Programmname).
- Technische Beschreibung: `docs/agents-und-rechte.md`, Abschnitt „System-Agents und ihre Modelle“.

---

## Offen

- **Printscreens fehlen.** Zu machen sind: Agents → System mit „Verwendet: CLI: …“, mit „Verwendet: Lokales Modell: …“, der Visionär mit „nur lesend“ und der Hinweis „ein eigener Agent … geht vor“. Sie lassen sich nachholen, wenn die App lokal läuft.
- **Die Tests sind für dieses Kapitel nicht erneut ausgeführt worden.** Der Entwickler-Bericht meldet sie nicht als gelaufen.
- **Der Hinweis „ein eigener Agent … geht vor“ erscheint immer** (außer bei der Schnellschätzung), auch ohne Projekt-Agent der Rolle. Das ist ein allgemeiner Hinweis. Ob er nur bei einem vorhandenen Agent erscheinen soll, ist eine Entscheidung für den Entwickler.
