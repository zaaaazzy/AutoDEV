# Phaser-Vorlage: „npx vitest run {tests}“ scheitert an Playwright-Dateien

Auftrag 314ff369 (Bugfix, 25.10.2026). Sprint 23. Aufgetreten bei TowerField am 25.10. (Aufträge cee5e7ca, 37b7c626, 3ab15370).

## Ursache

- Die Phaser-Vorlage (`src/setup/templates.ts`) führt je Auftrag `npx vitest run {tests}` aus.
- `relatedTestFiles` (`src/runner/order-tests.ts`) setzt für `{tests}` jede geänderte `*.spec.ts` ein, auch Playwright-Dateien unter `e2e/`.
- Vitest schliesst diese Dateien nicht ein und meldet „No test files found“ (Exit 1). Der Tester-Schritt wird rot und der Auftrag blockiert, obwohl am Code nichts falsch ist.

## Umsetzung

Gewählt ist die Variante „`{tests}` nimmt nur Dateien, die der jeweilige Runner einschliesst“, nicht `--passWithNoTests`. Das Flag würde auch echte Konfigurationsfehler verdecken, in denen keine Testdatei gefunden wird.

- **`isPlaywrightTest(path, content?)`:** Eine Datei zählt als Playwright-Test, wenn sie unter `e2e/` liegt oder `@playwright/test` importiert (`from` oder `require`). Ohne Inhalt entscheidet nur der Pfad.
- **`runsPlaywright(command)`:** Ein Befehl gilt als Playwright-Lauf, wenn ein Teil auf `playwright` endet (`npx playwright test …`, `node_modules/.bin/playwright …`).
- **`expandOrderCommands`:** `{tests}` bekommt je Befehl nur die passenden Dateien. Playwright-Befehle erhalten nur Playwright-Tests, alle anderen (Vitest, `tsx --test`, …) nur die übrigen. Bleibt die Liste leer, wird der Befehl wie bisher übersprungen.
- **`testerPlan`:** Liest den Inhalt jeder Testdatei, um Playwright-Tests auch ausserhalb von `e2e/` am Import zu erkennen. Ist die Datei nicht lesbar, entscheidet der Pfad.
- **Bestehende Projekte:** Der Fix wirkt im Runner, nicht in der Vorlage. Eine Migration der gespeicherten Befehle ist deshalb nicht nötig, und angepasste Befehle werden nicht angefasst. Ein von Hand ergänztes `--passWithNoTests` (TowerField) schadet nicht.

## Tests (`src/runner/order-tests.test.ts`)

Drei neue Tests:

1. Aufteilung je Runner: Ist nur `e2e/` geändert, wird der Vitest-Befehl übersprungen. Der alte Befehl mit `--passWithNoTests` läuft weiter.
2. Ein Playwright-Test ausserhalb von `e2e/` wird am Import erkannt.
3. Lauf über den eingebauten Tester: Nur eine Playwright-Datei geändert ergibt einen grünen Schritt. Ist zusätzlich ein Unit-Test geändert, der scheitert, bleibt der Schritt rot.

## Geänderte Dateien

- `src/runner/order-tests.ts`: Playwright-Erkennung, Aufteilung von `{tests}` je Runner.
- `src/runner/order-tests.test.ts`: die drei neuen Tests.
- `docs/installation.md`: Absatz bei der Phaser-Vorlage, wie `{tests}` je Runner gefiltert wird.
- `docs/phaser-vorlage-vitest-playwright-tests-2026-10-25.md`: diese Datei.

`src/setup/templates.ts` blieb unverändert.

## Worauf zu achten ist

- Ein Playwright-Test wird nur am Pfad (`e2e/`) oder am Import von `@playwright/test` erkannt. Eine Datei, die Playwright anders einbindet, geht an Vitest.
- Ändert ein Auftrag nur Playwright-Dateien, läuft der Vitest-Schritt nicht. Echte Vitest-Fehler bleiben rot (Test 3).
- Testlauf des Entwicklers (`npm test`): 1546 Tests, 1540 grün, 6 rot. Alle sechs liegen in `src/api/fail-closed.test.ts` (PATCH /bugs bzw. Bug-Freigabe, 500 statt 409). Sie gehören nicht zu diesem Auftrag, wirken aber wie ein Rest des Bug-Sprint-Auftrags 172c4f29 und müssen separat geprüft werden. `npm run typecheck` und `npm run lint` sind sauber.
- Tests in dieser Umgebung nur mit `npm test` oder `npm run …` starten. `npx tsx --test …` und Coverage-Flags blockiert der Wächter.
