# Nutzen-, Kosten- und Wertspalten in Offene Ideen

Auftrag ef5e6c78 (Entwicklung, Frontend).

## Aufträge

### Was umgesetzt wurde

Die Tabelle „Offene Ideen“ (Ideen-Seite) hat drei neue Spalten:

- **Nutzen** und **Kosten** (je 0–10): Balken mit Zahl, aufgebaut wie die Meter im Ideen-Dialog (`.meter`, `.meter-bar`). Nutzen 8 füllt 80 %, Kosten 3 füllen 30 %. Beide sind sortierbar und per Auswahl 0–10 filterbar.
- **Wert** = Nutzen / Kosten mit einer Nachkommastelle und deutschem Komma (8 und 3 → „2,7“). Nur sortierbar, kein Filter. Ohne Nutzen, ohne Kosten oder bei Kosten 0 bleibt die Zelle leer.
- Ideen ohne Wert (bzw. ohne Nutzen/Kosten beim Sortieren dieser Spalten) stehen in **beiden** Sortierrichtungen am Ende (`emptyLast`).
- **Standard-Sortierung:** „Wert“ absteigend, sobald die offenen Ideen mindestens eine Idee mit `source === 'visionary'` enthalten, sonst „Erstellt“ absteigend. Berechnet als `computed` aus `openIdeas()`.
- Die Spalte „Aufwand (Agent-Std.)“ bleibt, geht aber nicht in den Wert ein. Ideen-Dialog sowie die Gruppen „In Bearbeitung“ und „Abgeschlossen“ sind unverändert. Backend, Visionär-Lauf und Datenbank sind nicht berührt.

### Geänderte Dateien

- `frontend/src/app/features/ideation/idea-options.ts`: `SCORE_FILTER_OPTIONS`, `ideaValue`, `ideaValueText`, `VALUE_SORT`, `CREATED_SORT`, `openIdeasSort`.
- `frontend/src/app/features/ideation/ideation.component.ts` / `.html`: Spalten `benefit`, `cost`, `value`; Zelltemplate `scoreMeter` für die Balken; `[initialSort]="openIdeasSort()"`.
- `frontend/src/app/shared/data-table/sort.ts` (neu): `compareSortValues` mit Option `emptyLast`.
- `frontend/src/app/shared/data-table/data-table.component.ts`: `DataColumn.emptyLast`, `sortingFn` über `compareSortValues`; `sortBy()` behandelt eine voreingestellte Sortierung.
- `frontend/src/styles/04-components.css`: `.meter.table-meter` und Verwandte; die Meter-Styles liegen im gemeinsamen Stylesheet.
- `e2e/full-ui.check.ts`: neuer Oberflächentest (Balken 80 %/30 %, Wert „2,7“, leerer Wert, Klick auf „Wert“ kehrt um, Filter „Nutzen“, Standard-Sortierung, unveränderte Gruppen). Die Hilfsfunktion `seedScoredIdeas` (Zeile 59) schreibt Ideen direkt in die Testdatenbank, weil die API die Herkunft (`source`) nicht setzen kann; jeder Titel (Präfix „Wert:“) wird nur einmal angelegt. Die Visionär-Idee liegt in Projekt Beta, damit die übrigen Tests auf Alpha ihre Standard-Sortierung „Erstellt“ behalten. Lauf mit `npm run test:full`.
- Tests: `idea-value.spec.ts` (Formel, Formatierung, Filterwerte, Standard-Sortierung), `sort.spec.ts` (leere Werte in beiden Richtungen).

### Worauf zu achten ist

- TanStack dreht das Ergebnis der Sortierfunktion bei absteigender Sortierung um. Damit leere Werte trotzdem hinten stehen, spiegelt `compareSortValues` den Vergleich für leere Werte vorab (`desc`).
- Ein Klick auf eine Spalte mit nur voreingestellter Sortierung (hier „Wert“ absteigend) muss die Reihenfolge umkehren; `sortBy()` setzt dafür beim ersten Klick `desc: !preset.desc`. Danach gilt der normale Ablauf aufsteigend → absteigend → ohne.
- Der Leertext der Tabelle erwähnt Filter nur, wenn gefiltert oder gesucht wird (unverändert).
- Beschriftungen bestehender Tabellen wurden nicht geändert; die neuen Köpfe können aber E2E-Locators in `e2e/full-ui.check.ts` berühren.
- Die Formel ist eine Annahme (Nutzen/Kosten, Kosten 0 ausgeschlossen); ein Wechsel betrifft nur `ideaValue`.

### Tests

- Der jüngste Testlauf (bab69380, 30.10.2026, beschränkt auf die 11 geänderten Dateien) schlug wieder mit denselben Umgebungsfehlern fehl (`tsc: not found`, Exit 127; npm-Cache EACCES). Der Entwickler hat das Image nicht neu gebaut und keinen Code geändert. Weiterhin gibt es keine Aussage über Typprüfung und Unit-Tests; Image `aideation-agent` muss mit korrigiertem Dockerfile neu gebaut und das `node_modules`-Volume befüllt werden.
- Auch der erneute Testlauf (298dc4eb, 30.10.2026) schlug mit demselben Umgebungsfehler fehl. Der Hinweis zum Wiederholen lautet: Image „aideation-agent“ mit korrigiertem Dockerfile neu bauen, das `node_modules`-Volume einmal befüllen, dann den Tester erneut starten. Im letzten Entwicklerlauf wurde keine Datei geändert.
- Der frühere Testlauf (676b004f) schlug fehl, aus Umgebungsgründen: `tsc` nicht gefunden (Exit 127 im Image „aideation-agent“) und `npx tsx` scheiterte an einem root-eigenen npm-Cache (EACCES). Es gibt also noch keine Aussage über Typprüfung und Unit-Tests (`idea-options.spec.ts`, `idea-value.spec.ts`, `sort.spec.ts`). Die Dokumentation hat nichts erneut ausgeführt.
- Der Tester bemängelte zuvor den fehlenden E2E-Test; er wurde danach in `e2e/full-ui.check.ts` ergänzt, ist aber ungetestet (Playwright fehlt hier).
- Offen: `npm run typecheck`, `lint`, `format:check`, `test:unit` sowie `npm run test:full` (Oberflächentests „Tabellen“, „Ideen“, „Dashboard“, „Projektwechsel“) in einer funktionierenden Umgebung.

## Sprint

| Auftrag | Titel | Zustand | Details |
| --- | --- | --- | --- |
| ef5e6c78 | Nutzen-, Kosten- und Wertspalten in Offene Ideen | Umsetzung und E2E-Test fertig, Testlauf scheiterte an der Umgebung, Prüfung offen | Nur Frontend, kleiner Umfang |

## Anfrage / TODO

- Tester: Befehle und Oberflächentests aus „Tests“ in einer Umgebung mit `tsc`, `tsx` und Playwright ausführen. Prüfen, dass „Wert“-Klick bei Voreinstellung umkehrt und Ideen ohne Wert in beiden Richtungen hinten stehen.
- Der neue E2E-Test legt in Projekt Beta drei Ideen mit dem Präfix „Wert:“ an; das bei der Bereinigung der Testdaten beachten.
- Benutzerhandbuch ist angelegt (`benutzerhandbuch-offene-ideen-nutzen-kosten-wert-2026-10-30.md`).

## Technische Dokumentation

```mermaid
flowchart TD
  A[openIdeas] --> B{source === visionary?}
  B -- ja --> C[VALUE_SORT: value desc]
  B -- nein --> D[CREATED_SORT: createdAt desc]
  C --> E[app-data-table initialSort]
  D --> E
  E --> F[compareSortValues mit emptyLast]
```

- `ideaValue(idea)` liefert `benefit / cost` oder `null` (Nutzen/Kosten fehlen oder Kosten ≤ 0). `ideaValueText` formatiert mit `toLocaleString('de-DE')`, eine Nachkommastelle.
- Filter „Nutzen“/„Kosten“: `filter` mit `options = SCORE_FILTER_OPTIONS` (Strings „0“–„10“); die Spaltenwerte sind Zahlen, der Vergleich läuft über die Tabellen-Filterlogik (`shared/data-table/filter.ts`) und ist durch `idea-value.spec.ts` abgedeckt.
- `DataColumn.emptyLast` ist allgemein nutzbar; weitere Tabellen können es pro Spalte setzen.
