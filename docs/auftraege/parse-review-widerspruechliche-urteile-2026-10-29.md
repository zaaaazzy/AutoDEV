# parseReview: widersprüchliche Urteile werden abgelehnt

Auftrag a37caacd (Bugfix, Sprint 28). Aus dem Code-Review vom 20.10.2026.

## Aufträge

### a37caacd – parseReview: letztes Urteil zählt, nicht das erste

- **Zustand:** umgesetzt (Commit `2fbd295`), Tests grün.
- **Problem laut Auftrag:** `VERDICT.exec` nahm die erste Zeile mit `@@REVIEW: …`. Zitiert der Reviewer weiter oben `@@REVIEW: FREIGEGEBEN` (etwa aus einer von einem Agent präparierten Datei) und schließt mit „ÄNDERUNGEN NÖTIG“, galt der Auftrag als freigegeben.
- **Befund:** Der Fehler war bereits in Commit `d4901815` behoben. `parseReview` (`src/runner/review.ts:16-27`) liest alle Urteilszeilen mit `matchAll` und gibt nur frei, wenn keine davon „Änderungen nötig“ lautet (`every`).
- **Bewusste Abweichung vom Lösungsvorschlag:** „Letzten Treffer verwenden“ wurde nicht umgesetzt. Damit würde `ÄNDERUNGEN → FREIGEGEBEN` freigegeben, die Prüfung wäre lockerer als heute. Der Vorschlag nennt als Alternative „bei widersprüchlichen Urteilen ablehnen“. Das gilt weiter, konservativ als `false` (nicht `null`).
- **Neu in diesem Auftrag:** nur Regressionstests, kein Produktivcode.

## Geänderte Dateien

- `src/runner/review.test.ts`: drei neue Tests (insgesamt fünf).

## Tests

- Szenario aus dem Auftrag: zitiertes `FREIGEGEBEN`, am Schluss `ÄNDERUNGEN NÖTIG` ergibt `false`.
- Urteile im Fließtext oder in Backticks zählen nicht. Zitat mit anschließender Marker-Zeile: Die Marker-Zeile entscheidet. Nur ein Zitat ergibt `null`.
- Wiederholte Aufrufe mit derselben Antwort liefern dasselbe Ergebnis (das Regex mit Flag `g` ist modulweit geteilt, `matchAll` arbeitet auf einer Kopie). Zeilenenden mit CRLF werden richtig gelesen.
- Testlauf `npm test`: 1757 Tests, 1752 bestanden, 0 fehlgeschlagen, der Rest übersprungen. Alle fünf Tests in `review.test.ts` sind grün.

## Sprint 28

| Auftrag | Zustand | Details |
| --- | --- | --- |
| a37caacd parseReview: letztes Urteil zählt | umgesetzt, nur Tests ergänzt | Fix lag schon in `d4901815`; strenge Regel bleibt |

## Anfrage / TODO

- Keine offenen Punkte aus diesem Auftrag.
- Nicht auf „letzter Treffer gewinnt“ umstellen. Der Test `an interim approval does not override a later rejection` hält das fest.
- Hinweis: Die offenen Bug-Wächter-Einträge zeigen „monthly spend limit“ des Claude-Kontos. Das ist ein Kontolimit, kein Codefehler. Diese Schritte müssen nach Rücksetzung des Limits neu laufen.

## Technische Dokumentation

- `VERDICT` = `/^@@REVIEW:\s*(FREIGEGEBEN|ÄNDERUNGEN NÖTIG|AENDERUNGEN NOETIG)\s*$/gim`
  - `m`: Urteil nur am Zeilenanfang, Zitate im Fließtext zählen nicht.
  - `g`: von `matchAll` verlangt. Kein `exec` mit `lastIndex`-Zustand.
  - `i`: Groß-/Kleinschreibung egal, Ergebnis wird mit `toUpperCase` verglichen.
- Rückgabe: `true` = alle Urteile `FREIGEGEBEN`, `false` = mindestens ein Urteil „Änderungen nötig“, `null` = keine Urteilszeile.
- Beachten: Das Verhalten ist absichtlich asymmetrisch. Widerspruch führt immer zur Ablehnung.
