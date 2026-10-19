# 08 · Retrospektive & lernende Leitlinien

## Steckbrief

| Feld | Wert |
| --- | --- |
| Titel (Ideation) | Retrospektive-Agent: nach jedem Sprint aus Fehlern lernen und Änderungen an Leitlinien, DoR/DoD und Agent-Anweisungen vorschlagen |
| Kategorie | backend |
| Priorität | mittel |
| Nutzen | 8 |
| Kosten | 3 |
| Aufwand | ca. 12 h |
| Abhängigkeit | Redaktions-Workflow (`doc_revisions`) existiert bereits; Auslöser über 02 möglich |

## Beschreibung für Ideation (kopierfertig)

Nach jedem Sprint-Abschluss analysiert ein Retrospektive-Agent (nur lesend) den Sprint: blockierte Aufträge und ihre Ursachen, Bugs samt Fix-Notizen, Review-Befunde („Änderungen nötig“), Abweichungen Schätzung vs. Ist, wiederholte „Aktion notwendig“-Fälle und Schleifen-Abbrüche. Ergebnis ist ein Abschnitt „Retrospektive“ im Sprintbericht (gut gelaufen / schlecht gelaufen / Muster) und konkrete Änderungsvorschläge an den Projekt-Leitlinien, an Definition of Ready/Done und an den Anweisungen einzelner Agents. Die Vorschläge laufen als Änderung zur Prüfung durch die bestehende Redaktion: Ein Mensch nimmt sie an oder lehnt sie ab. Angenommene Regeln wirken ab dem nächsten Auftrag – die Agents lernen dauerhaft aus wiederkehrenden Fehlern.

## Problem heute

AIdeation sammelt Wissen pro Fehler (Bug-Wächter, „bekannte Bugs mit Lösung“), aber nicht über Muster: Wenn der Entwickler zum fünften Mal Tests vergisst oder die Handy-Ansicht bricht, ändert sich nichts an den Leitlinien. Leitlinien (`projects.guidelines`), DoR/DoD (`definition_of_ready/done`) und Agent-Anweisungen werden nur von Hand gepflegt. Der Sprintbericht (`sprint_reports`) zählt auf, was passiert ist, aber nicht, was daraus folgt.

## Vorschlag

1. **Auslöser:** Sprint wechselt auf `completed` (Trigger existiert für Git-Sync) → Retro-Lauf einreihen; zusätzlich per Knopf am Sprintbericht.
2. **Kontext:** Sprintbericht, alle `agent_run_steps` mit Status `failed` (gekürzte Ausgabe), Bugs des Sprints mit `fix_notes`, Review-Befunde, Abnahmepunkte `met=false`, `action_todo`-Texte, Schätzabweichungen, aktuelle Leitlinien/DoR/DoD/Agent-Anweisungen.
3. **Ausgabe:**
   - Markdown-Abschnitt „Retrospektive“ → `sprint_reports.notes` bzw. neues Feld `retro`
   - `@@RULE {"target":"guidelines|dor|dod|agent:<rolle>","change":"add|edit|remove","text":"…","evidence":"Aufträge X, Y, Z"}`
4. **Vorschläge als Revision:** Jede `@@RULE` wird als Änderungsvorschlag mit Begründung und Belegen eingereicht (analog `doc_revisions`, Rolle `editor` gibt frei). Annahme schreibt in `projects.guidelines`/DoR/DoD bzw. `agents.instructions`.
5. **Wirksamkeit messen:** Pro angenommener Regel wird gezählt, ob das zugehörige Muster in den Folge-Sprints seltener wird (Kategorie + Schlagwort) → Statistik „Lernkurve“.
6. **Ideen statt Regeln:** Muster, die eine Code-Änderung brauchen (z. B. „Hilfsfunktion fehlt“), werden als Idee (Quelle „Retrospektive“) angelegt – Brücke zu 01.

## Ablauf

```mermaid
flowchart TD
  C[Sprint abgeschlossen] --> R[Retrospektive-Agent liest Sprintdaten]
  R --> T[Abschnitt Retrospektive im Sprintbericht]
  R --> V[@@RULE-Vorschläge]
  R --> I[Ideen für Code-Änderungen]
  V --> E{Redaktion}
  E -- angenommen --> G[Leitlinien / DoR / DoD / Agent-Anweisung]
  E -- abgelehnt --> X[Begründung merken]
  G --> N[nächster Auftrag nutzt neue Regel]
  N --> M[Lernkurve messen]
```

## Andockpunkte im Code

- `src/api/reports.ts` – Sprintbericht, neues Feld `retro`
- `src/api/doc-revisions.ts` – Vorbild für „Änderung zur Prüfung“ (einreichen, freigeben, ablehnen)
- `src/runner/acceptance.ts` – DoR/DoD-Standardwerte und -Felder
- `src/runner/review.ts`, `src/runner/verify-acceptance.ts` – Befunde als Datenquelle
- `src/agent/troubleshoot.ts` – Problemanalyse (`analyst`) als Vorbild für Lese-Agent
- `src/api/agents.ts` – Agent-Anweisungen aktualisieren
- `frontend/src/app/features/sprints/`, `features/docs/` (Redaktionsansicht)

## Akzeptanzkriterien (Entwurf)

- Nach dem Abschluss eines Sprints erscheint im Sprintbericht ein Abschnitt „Retrospektive“ mit gut / schlecht / Muster.
- Jede vorgeschlagene Regel nennt Ziel (Leitlinien, DoR, DoD oder Agent), Text und Belege (verlinkte Aufträge/Bugs).
- Vorschläge erscheinen in der Redaktion und ändern nichts, bevor ein Mensch mit Rolle `editor` sie annimmt.
- Eine angenommene Regel ist im nächsten Agent-Prompt enthalten.
- Der Retro-Agent hat nur Lese-Werkzeuge und keine Befehle.
- Ein Sprint ohne Probleme erzeugt keine Regelvorschläge (kein Rauschen).

## Risiken & Grenzen

- Leitlinien wachsen unkontrolliert → Obergrenze, Retro darf auch „entfernen/zusammenfassen“ vorschlagen.
- Falsche Schlüsse aus wenigen Fällen → mindestens 2 Belege pro Regel.
- Lange Prompts für alle Agents → Regeln je Rolle statt alles in die globalen Leitlinien.

## Ausbaustufen

1. Retro-Abschnitt im Sprintbericht.
2. Regelvorschläge über die Redaktion.
3. Lernkurve in der Statistik.
4. Projektübergreifende Regeln (eine Regel, die in zwei Projekten half, als globale Vorlage anbieten).
