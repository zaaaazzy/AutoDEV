# Kompletter Test prüft halbfertigen Stand statt main

Auftrag a50140b9 (Bugfix, 25.10.2026). Gefunden bei der Gesamtprüfung vom 21.10.2026 (Bereich runner, Schwere mittel).

## Ziel

`useLatestMain` (`src/runner/test-request.ts`) checkt im Agent-Worktree `main` losgelöst aus, damit der „Kompletter Test“ den aktuellen Stand prüft. Bei offenen Änderungen gab die Funktion aber `null` zurück, und der Komplettlauf lief trotzdem im halbfertigen Stand. Typischer Fall: Ein Auftrag wartet nach dem Nutzungslimit mit WIP auf `auftrag/X`, kein Lauf ist `running`, also wird ein Komplettlauf beansprucht. Rote Ergebnisse wurden bei `--bugs` als neue Bugs angelegt, obwohl `main` gesund war.

## Umsetzung

- **`useLatestMain`** wirft jetzt in zwei Fällen, statt `null` zu liefern:
  - `git status --porcelain --untracked-files=no` zeigt Änderungen: „Offene Änderungen im Agent-Worktree (wartender Auftrag?) – Test auf main nicht möglich.“
  - `git status` scheitert: „git status im Agent-Worktree fehlgeschlagen – Test auf main nicht möglich: …“ (letzte Zeilen der Ausgabe).
- **`null` bleibt** für die Fälle, in denen der Test weiterlaufen soll: kein verknüpfter Worktree (Hauptordner), schon losgelöster Worktree.
- **Anforderung**: Sie steht ab `processTestRequest` schon auf `running`. Der Fehler wird im bestehenden `withProjectLock`-Block geworfen, der `catch` setzt sie auf `failed` und schreibt den Grund in `error`. Auf `requested` wird bewusst nicht zurückgesetzt, sonst würde sie sofort wieder beansprucht (Endlosschleife).
- **Vor der Ablehnung läuft nichts**: weder `runProjectCommand` noch ein Agent noch `fileBugs`; es wird auch kein `checkout` ausgeführt. `releaseTree` und `restoreBranch` bleiben im `finally`.
- Nicht versionierte Dateien zählen weiter nicht als offene Änderung (`--untracked-files=no`).

## Tests

- `src/runner/test-request.test.ts`, neuer Test „Komplettlauf: offene Änderungen im Agent-Worktree → kein Testbefehl, keine Bugs, Anforderung failed mit Grund“. Mock-`CommandExecutor` und Mock-Pool, kein echtes Git.
  - Schmutzig und `git status` fehlgeschlagen: kein `test:full`, kein Agent, kein `checkout --detach`, kein Bug-Insert, `failed` mit Grund.
  - Gegenproben: sauber, Hauptordner und schon losgelöst starten den Komplettlauf weiter.
- `src/core/test-bugs.test.ts`: der bestehende Fall für `useLatestMain` erwartet bei schmutzigem Stand jetzt eine Ablehnung statt `null`.

## Geänderte Dateien

- `src/runner/test-request.ts`
- `src/runner/test-request.test.ts`
- `src/core/test-bugs.test.ts`
- `docs/laufzeit.md` (Absatz zum Komplettlauf unter den Knöpfen der Oberfläche)

## Worauf zu achten ist

- **Verhalten**: Ein Komplettlauf im Worktree mit WIP scheitert mit klarer Meldung und wird nicht automatisch wiederholt. Wer ihn braucht, löst ihn nach Abschluss oder Verwerfen des wartenden Auftrags neu aus.
- **Bewusst offen**: Ein gescheitertes `git checkout --detach main` bei sauberem Stand bricht weiterhin nicht ab (mit dem Bug-Wächter so abgesprochen). Gesperrt werden nur „schmutzig“ und „git status fehlgeschlagen“.
- **Alternative verworfen**: Testen in einem frischen `git worktree add --detach main`. Mehr Aufwand (Abhängigkeiten, Aufräumen) für einen seltenen Fall.
- **Testlauf**: Der Entwickler meldet einen roten Test, `src/api/app.test.ts:608` („assigns development orders to sprints only within the same project“, 404 statt 400). Er berührt keine der geänderten Dateien. Dass der neue Test mit altem Code rot ist, wurde nur aus dem Code abgeleitet (`ran === false` scheitert), nicht ausgeführt, weil der Wächter einzelne Testdateien blockiert.
