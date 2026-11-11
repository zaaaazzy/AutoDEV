# Fortgesetzte Chat-Sitzung verliert Verweise und Nur-lesen-Hinweis

Auftrag 30efcc05 (Sprint 23, Bugfix, Schwere niedrig). Gefunden bei der Gesamtprüfung vom 21.10.2026 (Bereich: agent).

## Problem

Beantwortet der Nutzer eine Rückfrage des Chat-Agents, wird die Sitzung mit `--resume` fortgesetzt. Der Fortsetzungs-Prompt bestand nur aus Antworttext und Fragenregel. Zwei Teile des normalen Prompts fehlten:

- der Abschnitt „Verweise des Nutzers“ (`/auftrag/<id>`, `/bug/<id>`, `/doc/…`),
- der Nur-lesen-Hinweis, wenn der Projektordner belegt ist.

Folge: Der Agent sah den verlinkten Auftragstext nicht, versuchte Dateien zu ändern, wurde abgewiesen und antwortete ohne den Kontext.

## Umsetzung

Alles in `src/agent/chat.ts`:

- **Neue Funktion `resumePrompt(question, answer, references, readOnly)`** baut den Fortsetzungs-Prompt. Reihenfolge: Antwort auf die Rückfrage, Verweise (nur wenn nicht leer), „Arbeite damit weiter“ samt `QUESTION_RULE`, Nur-lesen-Hinweis (nur bei `readOnly`). Leere Teile werden weggelassen.
- **`processChat`** baut `resume` jetzt erst nach `referenceContext` und `claimChatTree`, weil `references` und `readOnly` vorher nicht bekannt sind.
- Die Projektregeln werden wie bisher in `src/agent/requirements.ts` vor den Prompt gestellt. Der normale Prompt ohne Fortsetzung ist unverändert, es wird nichts doppelt angehängt.

## Tests

`src/agent/chat.test.ts` (Hilfsfunktion `resumedRun`) ruft `processChat` mit nachgebauter Datenbank und einem `claude`-Befehl auf und prüft den Befehl mit `--resume`, den der Executor wirklich erhält:

1. Antwort mit `/auftrag`-Verweis: Prompt enthält „## Verweise des Nutzers“ und den Auftrag „Login“.
2. Ordner belegt (per `acquireTree` gesperrt): Prompt enthält den Nur-lesen-Hinweis.
3. Gegenprobe ohne Verweis und mit freiem Ordner: keiner der beiden Zusätze im Prompt.

Laut Entwickler scheitern Fall 1 und 2 ohne den Fix, die Gegenprobe läuft in beiden Fällen durch; `npm run test:unit`: 1625 von 1625 bestanden. Die Dokumentation hat nichts davon erneut ausgeführt.

## Geänderte Dateien

- `src/agent/chat.ts`
- `src/agent/chat.test.ts`

## Worauf zu achten ist

- `references` und `readOnly` müssen vor dem Bau von `resume` feststehen. Wer `processChat` umbaut, darf `resume` nicht wieder nach vorn ziehen.
- Neue Prompt-Bausteine im normalen Chat-Prompt müssen auch in `resumePrompt` bedacht werden, sonst entsteht dieselbe Lücke erneut.
- Keine Änderung an Bedienung, API, Schema oder Migrationen. Benutzerhandbuch deshalb unverändert.
- Die offenen Bugs in der Bug-Liste des Auftrags sind abgebrochene Läufe („monthly spend limit“) ohne inhaltliche Vorgabe und hatten keinen Einfluss auf diese Umsetzung.

## Sprint 23: Stand dieses Auftrags

| Auftrag | Zustand | Details |
| --- | --- | --- |
| Fortgesetzte Chat-Sitzung verliert Verweise und Nur-lesen-Hinweis (30efcc05) | umgesetzt, Tests grün, wartet auf Review/Freigabe | zwei Dateien, kein Schema, keine Doku-Änderung für Nutzer |

## Anfrage/TODO

- Keine neue Anfrage aus diesem Auftrag.
- Reviewer prüft: Test scheitert ohne Fix, kein doppeltes Anhängen beim normalen Prompt, Regelreihenfolge unverändert.
