# Auftragsautor schneidet Anforderung an erster „Schätzung…“-Überschrift ab

Auftrag 7f05b3f5 (Bugfix, Schwere niedrig, 25.10.2026). Sprint 23. Gefunden bei der Gesamtprüfung vom 21.10.2026 (Bereich agent).

## Ursache

`splitEstimate` (`src/agent/estimation.ts`) nahm den ersten Treffer von `ESTIMATE_SECTION`. Das Muster `Schätzung[^\n]*` passte auch auf `### Schätzungsgrundlage` unter „Technische Hinweise“. Alles danach galt als Schätzungsabschnitt: Diagramme und Abgrenzung fehlten in der Anforderung. Das JSON-Muster `\{[\s\S]*\}` griff zudem über Mermaid-Klammern, so dass die Schätzung leer blieb.

## Umsetzung

- **Überschrift eingeschränkt** (`ESTIMATE_HEADING`): Erlaubt sind nur „Schätzung“, „Schätzung (…)“ und „Schätzung:“, Ebene 1–4, ohne Beachtung der Groß-/Kleinschreibung. „Schätzungsgrundlage“ passt nicht mehr.
- **Letzter Treffer zählt:** Die Anforderung reicht bis vor die letzte passende Überschrift.
- **JSON nur aus dem letzten Abschnitt:** Der Text nach der Überschrift geht an `parseEstimate` (flache Objekte, von hinten zuerst). Das alte Greedy-Muster entfällt.
- **Aufgeräumt:** `toEstimate(json)` parst und prüft das JSON direkt, ohne Umweg über `splitEstimate`.
- **Regressionstest** (`src/agent/estimation.test.ts`): „`### Schätzungsgrundlage` und Mermaid-Klammern beenden die Anforderung nicht“. Er deckt ab: Schätzungsgrundlage + Mermaid + `## Schätzung (zuletzt, nur ein JSON-Objekt)` (Anforderung bis „Abgrenzung“, Schätzung gelesen), mehrere Schätzungsabschnitte (der letzte zählt), nur Schätzungsgrundlage (`estimate: null`, Text vollständig), Überschrift mit Doppelpunkt und JSON im Codeblock.

## Geänderte Dateien

- `src/agent/estimation.ts`
- `src/agent/estimation.test.ts` (1 neuer Test)

Commit `5b58cdf`.

## Worauf zu achten ist

- **Tests nicht gelaufen:** Entwickler und Dokumentierer konnten sie nicht ausführen (fehlende Freigabe). Der Tester soll gezielt `npx --no-install tsx --test src/agent/estimation.test.ts` starten, ohne Coverage-Flag und nicht die ganze Suite.
- **Rot-vor-Fix nicht belegt:** Dass der neue Test mit dem alten Code scheitert, wurde nur gedanklich geprüft.
- **Bestehende Fälle:** `### Schätzung (zuletzt)`, `# schätzung`, leerer Abschnitt, kaputtes JSON und `{}` sollen unverändert grün bleiben.
- **Strengere Überschrift:** Varianten wie „Schätzung des Aufwands“ gelten nicht mehr als Schätzungsabschnitt. Hält sich der Autor an das Format (`## Schätzung`), gibt es keinen Unterschied.
- Fehler unter `src/runner/…` und `src/api/push.test.ts` stammen nicht von diesem Auftrag.

## Sprint 23

| Auftrag | Zustand | Details |
| --- | --- | --- |
| 7f05b3f5 Auftragsautor schneidet Anforderung ab | umgesetzt, Test wartet auf Tester | Letzte „Schätzung“-Überschrift, JSON nur aus diesem Abschnitt, Regressionstest |

## Anfrage / TODO

- `estimation.test.ts` gezielt ausführen und bestätigen, dass der neue Test mit dem alten Code rot gewesen wäre.
