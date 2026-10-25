# Fremde Texte aus Ingest und Chat-Verweisen als nicht vertrauenswürdig markieren (25.10.2026)

Auftrag c010e86c (Bugfix, Sprint 23, aus dem Code-Review vom 21.10.2026, Stand `a4971e9`).

## Problem
- Bugs aus dem Produktions-Ingest (Fehlermeldung, Stack; jeder mit dem öffentlichen Snippet-Token kann sie senden) standen im Prompt ohne Einfassung. Damit fehlte auch der Sicherheitshinweis `UNTRUSTED_HINT`.
- Der Block „Bekannte Bugs“ (Agent-Prompt, Bug-Wächter) gab Titel, Beschreibung und Lösung freigegebener Fremd-Bugs ungeschützt weiter.
- Chat-Verweise auf Auftrag, Idee oder Bug gingen ohne Hinweis in den Prompt des voll berechtigten Assistenten.
- Szenario: Ein präparierter Fehlertext steuert einen Agent, der Dateien schreiben und Befehle ausführen darf.

## Änderung
- **`src/core/bug-trust.ts`:** neue Funktion `fenceExternalText`. Sie fasst Text in `<<<FREMDER-TEXT …>>>` ein und entschärft vorher Marker, Steuerzeichen und Codezäune über `plainExternalText` (`<<<`/`>>>` werden zu `‹‹‹`/`›››`). Der Text kann den Block weder öffnen noch vorzeitig schließen.
- **`src/core/known-bugs.ts` (neu):** `knownBugLine` baut die Zeile für „Bekannte Bugs“. Bugs aus Betrieb oder GitHub (`isUntrustedBugSource`) und Texte, die schon Marker enthalten, stehen eingefasst. Eigene Bugs bleiben unverändert in einer Zeile.
- **`src/runner/runner-prompts.ts`:** `buildPrompt` nutzt `knownBugLine`. Der Hinweis `UNTRUSTED_HINT` kommt, wenn Auftragsbeschreibung, Bug-Quelle oder ein Eintrag unter „Bekannte Bugs“ Fremdtext enthält.
- **`src/agent/requirements.ts`:** `assessRisks` (Bug-Wächter) nutzt `knownBugLine` und setzt den Hinweis, wenn die Bug-Liste Fremdtext enthält.
- **`src/api/bugs.ts`:** `KnownBug` und `loadKnownBugs` liefern zusätzlich `source`.
- **`src/agent/chat-references.ts`:** neue Hilfe `itemContext`. Aufträge (über `bugs.source` des verknüpften Bugs, auch Altdaten ohne Marker), Ideen (`source`) und Bugs aus Betrieb oder GitHub stehen samt Titel eingefasst. Dasselbe gilt für schon markierten Text. `referenceContext` hängt dann `UNTRUSTED_HINT` an.
- **Doku:** drei Punkte im Abschnitt Produktions-Rückkanal in `docs/laufzeit.md`.
- `src/runner/production-events.ts` blieb unverändert; die Einfassung der Ingest-Beschreibung gab es dort schon, die Lücke lag in den Prompt-Wegen.

## Tests
- `src/agent/chat-references.test.ts`: Verweise auf fremde Aufträge, Ideen und Bugs sind eingefasst und mit Hinweis versehen. Eigene Inhalte bleiben ohne. Marker im Text werden entschärft.
- `src/runner/bug-approval.test.ts`: freigegebene Fremd-Bugs unter „Bekannte Bugs“ stehen eingefasst, der Prompt enthält den Hinweis.
- `src/runner/runner.test.ts`: Erwartung an die Zeilen für „Bekannte Bugs“ angepasst.

## Worauf zu achten ist
- Stand der Prüfung: Die Tests wurden im Entwicklerschritt nicht ausgeführt (Befehle gesperrt). Ob die neuen Tests ohne den Fix rot wären, ist nicht belegt. Der Tester soll einzeln laufen lassen: `npx --no-install tsx --test src/agent/chat-references.test.ts`, `src/runner/bug-approval.test.ts`, `src/runner/runner.test.ts`, dazu `npx --no-install prettier --check` auf die geänderten Dateien.
- Bei Verweisen auf einen Sprint stehen Auftragstitel wie „Bug: Betrieb: …“ weiter ohne Einfassung. Sie sind bereits bereinigt und auf 90 Zeichen gekürzt; bewusst so belassen.
- Zeilenumbrüche in `chat-references.test.ts` können durch Prettier nachgezogen werden.
- Abgrenzung: „Ingest-Bugs nicht automatisch an Code-Agents geben“ (Sprint 9) ist ein eigener Auftrag. Hier geht es nur um die Markierung im Prompt.
- Der Hinweis schützt nur als Anweisung an das Modell; er ersetzt weder die Freigabe durch Menschen noch die Rechte-Prüfung der Agents.

## Geänderte Dateien
`docs/laufzeit.md`, `src/agent/chat-references.ts`, `src/agent/chat-references.test.ts`, `src/agent/requirements.ts`, `src/api/bugs.ts`, `src/core/bug-trust.ts`, `src/core/known-bugs.ts` (neu), `src/runner/bug-approval.test.ts`, `src/runner/runner-prompts.ts`, `src/runner/runner.test.ts`.
