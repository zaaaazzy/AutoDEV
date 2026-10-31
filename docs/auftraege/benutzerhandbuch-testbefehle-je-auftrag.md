# Benutzerhandbuch: Testbefehle je Auftrag (Platzhalter `{tests}` und `{files}`)

Dieses Kapitel beschreibt, wie die Testbefehle je Auftrag im Tester-Schritt gefiltert werden. Es gilt für alle Projekte, auch für
Projekte aus der Phaser-Vorlage, und ändert nichts an den Befehlen, die du schon gespeichert hast.

## 1. Wo du die Befehle einstellst

**Einstellungen → Qualität & Tests → „Testbefehle je Auftrag (ein Befehl pro Zeile)“.**

- Jede Zeile ist ein eigener Befehl. Die Befehle laufen nacheinander im Tester-Schritt eines Auftrags.
- Leer lassen: Es gilt dieselbe Liste wie für „Testbefehle beim Live schalten“.
- Das Feld „Testbefehle beim Live schalten“ hat damit nichts zu tun. Es gilt nur beim Live schalten.

Die Phaser-Vorlage füllt die Liste beim Anlegen vor mit `npm run typecheck`, `npx vitest run {tests}` und
`npm run test:smoke`. Du kannst sie danach frei ändern.

## 2. Was die Platzhalter einsetzen

| Platzhalter | Wird ersetzt durch |
|---|---|
| `{tests}` | Testdateien zu den geänderten Dateien des Auftrags (`*.spec.ts`, `*.test.ts`), nur die zu diesem Befehl passenden (siehe Abschnitt 3) |
| `{files}` | Die geänderten Dateien des Auftrags, die es noch gibt |

- Jede Datei wird als eigenes Argument eingesetzt.
- Ein Befehl **mit** Platzhalter, bei dem nach dem Einsetzen keine Datei übrig bleibt, wird **übersprungen**. Er wird nicht
  ausgeführt und gilt deshalb auch nicht als rot.
- Ein Befehl **ohne** Platzhalter (z. B. `npm run typecheck`) läuft immer.

## 3. Playwright-Tests und andere Test-Runner

`{tests}` bekommt nur die Dateien, die der jeweilige Befehl auch ausführen kann:

- **Playwright-Tests** sind Dateien unter `e2e/` oder Dateien mit `import … from '@playwright/test'`. Sie gehen nur an
  Befehle, in denen `playwright` vorkommt (z. B. `npx playwright test {tests}`).
- **Alle anderen Testdateien** gehen an die übrigen Befehle (Vitest, `tsx --test`, …).

Beispiel: Ein Auftrag ändert nur `e2e/smoke.spec.ts`. Dann wird `npx vitest run {tests}` **übersprungen** und der Tester-Schritt
bleibt grün. Der Befehl „No test files found“ kommt nicht mehr vor. Ändert der Auftrag zusätzlich eine Vitest-Datei, die
scheitert, bleibt der Schritt rot.

## 4. Bedingungen und Grenzen

- **Bestehende Projekte:** Du musst nichts umstellen. Die Filterung passiert beim Ausführen, nicht beim Speichern der Befehle.
- **`--passWithNoTests`** ist nicht nötig. Ein von Hand ergänztes Flag schadet nicht, es verdeckt aber echte
  Konfigurationsfehler (etwa einen falschen Dateipfad). Deshalb ist die Filterung die bevorzugte Lösung.
- Ein Befehl ohne das Wort `playwright` bekommt keine Playwright-Dateien, auch nicht, wenn er nur `{tests}` enthält.
- `{files}` wird nicht gefiltert. Ein Befehl mit `{files}` bekommt alle geänderten Dateien, auch Playwright-Dateien.
- Die Prüfung, ob eine Datei ein Playwright-Test ist, liest die Datei. Ist sie nicht lesbar, zählt nur der Pfad.

## 5. Fehlerbehebung

| Meldung oder Zustand | Ursache | Was du tust |
|---|---|---|
| Vitest-Schritt rot mit „No test files found“ | Ein Befehl mit `{tests}` bekommt nur Playwright-Dateien, die er nicht ausführen kann. Das sollte mit dem aktuellen Stand nicht mehr passieren. | Prüfe, ob der Befehl das Wort `playwright` enthält, wenn er Playwright-Tests laufen lassen soll. Sonst passt er zu Vitest. |
| Ein Befehl steht im Lauf nicht drin | Sein `{tests}` oder `{files}` ist leer, also gibt es für diesen Runner keine passende Datei. | Das ist gewollt. Prüfe nur, ob du die richtige Datei geändert hast. |
| Der Tester führt `npx tsx --test …` nicht aus | Die Rechte-Gruppe „Build und Tests“ erlaubt `npm test` und `npm run`. | Lege den Befehl als `npm run …`-Skript an. Siehe [Rechte je Rolle](benutzerhandbuch-dashboard-agents.md). |

## 6. Printscreens

Für dieses Kapitel fehlen noch die Printscreens der Einstellungsmaske „Qualität & Tests“ (Felder „Testbefehle je Auftrag“ und
die Hinweise darunter) und eines Tester-Laufs mit übersprungenem Befehl. Sie werden nachgereicht, sobald die App im Browser
läuft. Diese Sitzung hat dafür weder Browser noch laufende App. Die Beschreibung oben stammt aus dem Quelltext
(`frontend/src/app/features/settings/settings.component.html`, `src/runner/order-tests.ts`) und aus dem Ergebnis der
Tests des Entwicklers. Die Tests selbst habe ich in dieser Sitzung nicht ausgeführt.

## 7. Grenzen dieses Kapitels

- Es beschreibt nur die Filterung von `{tests}` und `{files}`. Die übrigen Befehle und Einstellungen stehen in den anderen
  Kapiteln und in [Installation](../installation.md).
- Die Filterung kennt nur zwei Gruppen: Playwright und alle übrigen Testdateien. Mehrere Runner in einer Gruppe werden nicht
  weiter aufgeteilt.
