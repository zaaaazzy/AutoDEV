# Gegenprobe: neue Testfälle müssen ohne Fix scheitern (2026-10-31)

Auftrag 48c732e5-e6cf-490e-ac75-a735c5baf6bf.

## Was sich ändert

Bei Bugfix-Aufträgen (`kind = 'bug'`) läuft nach einem grünen Tester-Schritt automatisch eine Gegenprobe. Geprüft
wird jeder Testfall, den der Auftrag neu hinzugefügt hat, und zwar auf dem Stand vor dem Auftrag. Besteht dort
mindestens einer, gilt der Tester-Schritt als rot mit der Markierung **„Test belegt den Fix nicht“**. Der Auftrag
geht dann über den bestehenden Weg für rote Tests an den Entwickler zurück: einmal je Lauf zur Nachbesserung,
danach Bug-Bericht wie bei roten Tests. Eine Endlosschleife ist so ausgeschlossen.

Die ältere Prüfung je Testdatei beim Sprint-Abschluss (`src/runner/git-sync/counter-check.ts`) bleibt als
Rückfallebene erhalten. Sie läuft nur für Aufträge, an denen noch kein Ergebnis gespeichert ist (`counter_check IS NULL`).

## Ablauf (`src/runner/counter-probe.ts`)

1. **Basis:** `git merge-base HEAD <Basis-Branch des Auftrags>` (Sprint-Branch oder main). Die Basis ist also nicht
   der Vorgänger eines einzelnen Commits, denn ein Auftrag hat mehrere Commits (je Agent, WIP, nachgezogene Basis).
2. **Neue Testfälle:** Je geänderter Testdatei (`*.test|spec.(ts|mjs|js)`, ohne Playwright und ohne `e2e/`)
   werden die Namen aus `test('…')`/`it('…')` (auch `.only`) im Arbeitsordner mit denen auf der Basis verglichen.
   Bei einer neuen Datei zählen alle Fälle. Nicht erfasst werden `.skip`/`.todo`, `t.test(…)` und Namen mit `${…}`.
   Noch nicht committete Tests des Testers sind enthalten.
3. **Worktree:** `git worktree add --detach <tmp>/aideation-probe-…` auf die Basis. Dort hinein kommen nur die
   Testdateien aus dem Auftrag, der Produktivcode bleibt alt. `.env` und Projektdateien außerhalb von Git werden
   nicht kopiert. `node_modules` werden nur ohne Sandbox verlinkt (wie bei der bisherigen Gegenprobe).
4. **Ausführung:** Es laufen die Testbefehle je Auftrag mit `{tests}`. Direkt vor den Platzhalter kommt
   `--test-name-pattern=(?:^| )(?:Name1|Name2)$`, damit nur die neuen Fälle laufen (auch innerhalb von `describe`).
   Die Befehle laufen über `runProjectCommand` (gefilterte Umgebung) im Testcontainer (`gateExecutor`) wie das Gate.
   Grenzen: 5 Minuten je Befehl, 10 Minuten insgesamt.
5. **Ergebnis je Testfall** (aus TAP- oder Spec-Ausgabe):
   - „scheitert wie erwartet“
   - „besteht (Fix nicht belegt)“: Ein bestandener Fall wird einmal wiederholt. Besteht er dabei nicht erneut, gilt
     er als „nicht auswertbar (wackelig)“.
   - „nicht auswertbar“: Lade-, Import- oder Syntaxfehler vor dem ersten Testfall, Zeitüberschreitung,
     Sandbox-Fehler, fehlender Befehl, Namensfilter ohne Treffer.
6. **Aufräumen:** Der Worktree wird in `finally` entfernt, auch bei Fehlern und Zeitüberschreitung. Was ein harter
   Abbruch (SIGKILL) hinterlässt, entfernt der nächste Lauf, sobald es älter als zwei Stunden ist. Der Präfix
   unterscheidet sich von der Sprint-Gegenprobe, damit sich die beiden nicht gegenseitig abräumen.

Das Urteil `verdict` ist eines der folgenden:

- `proven`: Alle neuen Fälle scheitern.
- `unproven`: Mindestens ein Fall besteht. Nur dieser Fall gibt den Auftrag zurück.
- `inconclusive`: Kein Fall besteht, aber nicht alle sind auswertbar. Das ist weder Beleg noch Rückgabegrund.
- `none`: Es gibt keine neuen Testfälle, also keinen Lauf. Der Grund steht im Bericht.

## Ergebnis sichtbar

- **Am Auftrag:** Das Ergebnis steht in `development_items.counter_check`, die Spalte gibt es bereits. Neu sind die
  Felder `cases`, `verdict` und `reason`. Jede Gegenprobe überschreibt die vorige, ein erneuter Versuch setzt die
  Markierung also zurück. Das Auftragsdetail zeigt je Testfall Name, Datei und Ergebnis sowie die Markierung.
- **Testbericht:** Der Abschnitt „## Gegenprobe“ landet im jüngsten `docs/tests/<Lauf>/bericht.md`, der seit Beginn
  des Tester-Schritts entstanden ist (`test:full`). Gibt es keinen, etwa bei Projekten mit `test-agent`, entsteht
  `docs/tests/<Datum_Uhrzeit>_gegenprobe/bericht.md`. Derselbe Abschnitt steht in der Ausgabe des Tester-Schritts,
  der Entwickler bekommt ihn also bei der Rückgabe als Rückmeldung.
- **Verlauf des Schritts:** „Gegenprobe: x scheitern wie erwartet, y bestehen, z nicht auswertbar …“.

## Grenzen

- Der Namensfilter arbeitet mit node:test bzw. `tsx --test`. Andere Runner (Vitest, Jest) melden die Fälle als
  „nicht auswertbar“.
- Ohne Testbefehle je Auftrag mit `{tests}` (Projekteinstellung) ist jeder Fall „nicht auswertbar“, der Grund steht
  im Bericht.
- Die Gegenprobe selbst ändert im Arbeitsordner nur den Bericht unter `docs/tests/`. Git-Stand, Index, HEAD und
  Branches bleiben unberührt, das ist mit einem echten Repository getestet.

## Geänderte Dateien

- `src/runner/counter-probe.ts` (neu): Diff-Erkennung, Worktree, Klassifikation, Bericht.
- `src/runner/counter-probe.test.ts` (neu): Unit-Tests, Fixture mit echtem Git-Repo (auch ein absichtlich nicht
  gefixter Stand) und Einbindung in den Tester-Schritt.
- `src/runner/runner-steps.ts`: Gegenprobe im Tester-Schritt von Bugfixes, rot bei `unproven`.
- `src/core/shared-types.ts`: Typen, Texte und Markierung, die Backend und Oberfläche teilen.
- `src/db/development-repository.ts`: `saveCounterCheck`.
- `src/runner/git-sync/counter-check.ts`: Felder `cases`/`verdict`/`reason`, Helfer exportiert.
- `src/runner/runner-prompts.ts`: Hinweis an den Dokumentierer angepasst.
- `frontend/src/app/core/models.ts` und `frontend/src/app/features/development/order-detail.component.{ts,html}`:
  Anzeige je Testfall und Markierung.
