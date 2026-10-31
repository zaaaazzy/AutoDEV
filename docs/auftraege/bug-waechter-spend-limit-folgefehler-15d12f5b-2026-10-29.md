# Bug-Wächter: Folgefehler des Spend-Limits (Kleine API-Aufräumarbeiten)

Auftrag 15d12f5b (Bugfix). Titel: „Bug: Bug-Wächter: Kleine API-Aufräumarbeiten: Sprint-Index, SQL-Ersetzung…“.

## Problem

- Der Bug wurde automatisch angelegt, weil der Schritt „Bug-Wächter“ des Auftrags „Kleine API-Aufräumarbeiten: Sprint-Index, SQL-Ersetzung, Chat-Stream“ fehlschlug.
- Der Wächter hat nie gearbeitet. Die Claude-CLI brach sofort mit der Meldung „You've hit your monthly spend limit … your session limit resets 8:50pm (Europe/Zurich)“ ab. Diese Meldung wurde als Bug-Text übernommen.
- Ein Code-Defekt in Sprint-Index, SQL-Ersetzung oder Chat-Stream liegt nicht vor. Der Merge `bf4e903` dieses Auftrags ist bereits durch.

## Umsetzung

Es wurde kein Code geändert. Der Entwickler hat die Ursache geprüft und den Bug ohne Änderung abgeschlossen („Ursache: Spend-Limit der Claude-CLI“).

Die Limit-Erkennung im Runner besteht bereits:

- `runner-steps.ts:342` und `autofix.ts` erkennen Ausgaben mit „spend limit“ (seit 21.10. Erkennung, seit 28.10. mit dieser Meldung, Commit `cff88be`).
- Tests: `autofix.test.ts:132`, `pre-sprint.test.ts:101`, `sandbox.test.ts:414`. Sie wurden in diesem Lauf nicht ausgeführt.

## Geänderte Dateien

Keine. (Nur diese Dokumentation wurde ergänzt.)

## Sprint

| Auftrag | Titel | Art | Zustand |
|---|---|---|---|
| 15d12f5b | Bug-Wächter: Kleine API-Aufräumarbeiten: Sprint-Index, SQL-Ersetzung… | Bugfix | ohne Code-Änderung abgeschlossen, Ursache Spend-Limit |

## Anfrage / TODO

- Neustart erst nach dem Reset (8:50pm Europe/Zurich) oder mit höherem Limit unter claude.ai/settings/usage. Sonst entsteht sofort wieder ein gleicher Bug.
- Prüfen, ob der Worker seit dem 28.10. neu gestartet wurde. Läuft er mit älterem Code, erklärt das, warum trotz Erkennung ein Bug entstand.
- Tritt der Fall nach einem Neustart erneut auf, bitte Exit-Code des Schritts aus `agent_run_steps` und die Rohausgabe mitliefern. Nur so lässt sich eine echte Lücke finden.
- Keine `npm install`-, Builder- oder Versionswechsel-Schritte einplanen, Agents dürfen diese nicht ausführen.

## Technische Dokumentation

- Ausgaben mit „spend limit“ sollen den Lauf als pausiert/Limit markieren und keinen Bug „Bug-Wächter: …“ erzeugen (`runner-steps.ts`, `autofix.ts`).
- Gleichartige Bugs mit der Limit-Meldung im Text (u. a. Review-Box, Doku-Angleich, Git-Verlauf, Push-Abos) sind reine Abbrüche durch das Kostenlimit.

## Worauf zu achten ist

- Vor jeder Fehleranalyse prüfen, ob der Agent wirklich gearbeitet hat. Ein sauberes Arbeitsverzeichnis heißt nicht „Auftrag erfüllt“.
- Limit-Meldungen gehören nicht in „Risiken“ oder Bug-Texte.
