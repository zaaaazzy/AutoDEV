# Benutzerhandbuch: Urteil des Reviewers bei widersprüchlichen Angaben

Dieses Kapitel beschreibt, wann ein Reviewer-Schritt als bestanden gilt und was du im Verlauf siehst, wenn der Reviewer widersprüchliche Urteile schreibt. Es ändert nichts an gespeicherten Daten und nichts an der Oberfläche. Die Änderung betrifft nur die Auswertung der Antwort des Reviewers.

## 1. Was neu ist

- **Widersprüche führen zur Ablehnung.** Steht in der Antwort des Reviewers mindestens einmal „ÄNDERUNGEN NÖTIG“, gilt der Auftrag als abgelehnt. Das gilt auch dann, wenn später in derselben Antwort „FREIGEGEBEN“ steht.
- **Zitate zählen nicht.** Ein Urteil zählt nur, wenn es als eigene Zeile am Zeilenanfang steht. Ein Zitat mitten in einem Satz oder in Backticks zählt nicht.
- **Keine Freigabe aus einem Zitat.** Stehen in einer Datei des Auftrags Urteilszeilen wie `@@REVIEW: FREIGEGEBEN`, und der Reviewer schliesst mit „ÄNDERUNGEN NÖTIG“, bleibt der Auftrag abgelehnt. Vorher hätte die erste Zeile gezählt.

## 2. Welches Urteil wie gewertet wird

Der Reviewer beendet seine Antwort mit einer Urteilszeile. Die Auswertung läuft so:

| Antwort des Reviewers | Ergebnis | Verlauf-Eintrag |
|---|---|---|
| Nur `@@REVIEW: FREIGEGEBEN` | bestanden | „Review: freigegeben“ |
| Mindestens eine Zeile `@@REVIEW: ÄNDERUNGEN NÖTIG` (in welcher Reihenfolge auch immer) | nicht bestanden | „Review: Änderungen nötig“ |
| Keine Urteilszeile am Zeilenanfang | nicht bestanden | „Review ohne eindeutiges Ergebnis“ |
| Nur Zitate im Fliesstext, keine Urteilszeile | nicht bestanden | „Review ohne eindeutiges Ergebnis“ |

Dazu gelten diese Regeln:

- Die Schreibweise `AENDERUNGEN NOETIG` (ohne Umlaute) wird wie `ÄNDERUNGEN NÖTIG` gewertet. Gross- und Kleinschreibung ist egal.
- Leerzeichen am Zeilenende sind erlaubt. Leerzeichen am Zeilenanfang nicht, dann zählt die Zeile nicht.
- Zeilenenden mit Windows-Format (CRLF) werden richtig gelesen.
- Der Reviewer muss zusätzlich mit Exit-Code 0 enden. Sonst gilt der Schritt unabhängig vom Urteil als nicht bestanden.

## 3. Warum widersprüchliche Urteile abgelehnt werden

Ein Agent kann Texte aus Dateien des Auftrags übernehmen, die nicht von dir stammen. Darin kann ein fertiges „FREIGEGEBEN“ stehen. Wenn der Reviewer am Ende „ÄNDERUNGEN NÖTIG“ schreibt, soll der Auftrag nicht durchrutschen. Deshalb entscheidet ein einziges „ÄNDERUNGEN NÖTIG“ immer gegen die Freigabe. Eine Lockerung auf „der letzte Treffer gewinnt“ wurde bewusst nicht gemacht.

## 4. Was du tust

- **Bei „Review: freigegeben“:** Nichts. Der Schritt ist bestanden.
- **Bei „Review: Änderungen nötig“:** Lies die nummerierten Befunde des Reviewers im Verlauf des Schritts. Beheb die blockierenden Punkte und starte den Auftrag erneut. Bereits bestandene Agents werden dabei übersprungen, der Reviewer läuft neu.
- **Bei „Review ohne eindeutiges Ergebnis“:** Prüfe die Ausgabe des Reviewers im Verlauf. Fehlt die Urteilszeile, hat der Reviewer den Auftrag nicht beendet. Die Ursache kann auch ein Zitat sein, das am Zeilenanfang steht. Starte den Reviewer erneut. Hilft das nicht, ist der Reviewer-Prompt zu prüfen.

## 5. Bedingungen und Ausnahmen

- Die Regel gilt nur für den Reviewer. Der Tester und der Entwickler werten ihre Antworten anders aus.
- Die Regel betrifft nur die Urteilszeile. Die Befunde im Text des Reviewers werden nicht ausgewertet. Sie stehen nur im Verlauf.
- Ein Eintrag „Abgelehnt wegen Projektregel“ (`@@REGEL`) ist ein eigener Fall und wird nicht von dieser Regel behandelt.
- Eine Lockerung auf „der letzte Treffer gewinnt“ würde ein „ÄNDERUNGEN NÖTIG“ überschreiben. Das ist nicht vorgesehen.

## 6. Fehlerbehebung

| Verlauf zeigt | Ursache | Was du tust |
|---|---|---|
| „Review: Änderungen nötig“, obwohl der Reviewer „FREIGEGEBEN“ geschrieben hat | Der Reviewer hat irgendwo in seiner Antwort auch „ÄNDERUNGEN NÖTIG“ als Urteilszeile geschrieben, auch in einer Zwischenfassung. | Antwort des Reviewers im Verlauf öffnen und die Urteilszeilen zählen. Den Reviewer bitten, nur ein Urteil am Ende zu schreiben. |
| „Review ohne eindeutiges Ergebnis“ bei sonst sinnvoller Antwort | Die Urteilszeile fehlt, steht nicht am Zeilenanfang oder hat eine andere Schreibweise. | Reviewer erneut laufen lassen. Die Zeile muss exakt `@@REVIEW: FREIGEGEBEN` oder `@@REVIEW: ÄNDERUNGEN NÖTIG` lauten. |
| Schritt nicht bestanden trotz „Review: freigegeben“ | Der Agent hat mit einem Exit-Code ungleich 0 geendet. | Verlauf auf den Fehler des Agents prüfen. Das Urteil allein reicht dann nicht. |

## 7. Printscreens

Für dieses Kapitel fehlen noch die Aufnahmen. Die App und ein echter Reviewer-Lauf konnten in dieser Umgebung nicht durchgespielt werden, deshalb gibt es keine Bilder. Nötig wären:

1. Auftrag-Verlauf mit dem Eintrag „Review: Änderungen nötig“ und dem Befund des Reviewers.
2. Auftrag-Verlauf mit dem Eintrag „Review ohne eindeutiges Ergebnis“.
3. Auftrag-Verlauf mit dem Eintrag „Review: freigegeben“.

## 8. Nicht geprüft

- Die Tests in `src/runner/review.test.ts` wurden in diesem Lauf nicht selbst ausgeführt. Die Zahlen stammen vom Entwickler (1757 Tests, 1752 bestanden, 0 fehlgeschlagen laut Entwickler-Bericht).
- Die Anzeige der Verlaufseinträge in der Oberfläche ist nicht geprüft. Die Oberfläche wurde nicht geändert.
- Der Reviewer-Prompt ist nicht geändert. Ob ein Modell die Urteilszeile immer am Ende einhält, hängt vom Modell ab und ist hier nicht getestet.
