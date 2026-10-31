# Benutzerhandbuch: `npm run test:unit` im Agent-Container (Auftrag 788ec856)

Stand: 31.10.2026. Der Auftragsbericht steht in `docs/auftraege/ci-cd-test-unit-2026-10-31.md`, die Risiken in `docs/risiken/ci-cd-test-unit-2026-10-31.md`.

Betroffen sind Entwickler und Betreiber. Es gibt keine neue Seite, keine neue Schaltfläche und keine geänderte Oberfläche. Deshalb entfallen die Printscreens.

## Was sich ändert

1. **Abhängigkeiten im Agent-Volume.** Das `node_modules`-Volume des Projekts (`aideation_worker_modules`) befüllt jetzt der Worker selbst, in `ensureDependencies` (`src/core/sandbox.ts`). Es gibt nur noch diesen Weg. Im Code findet sich kein `npm ci` mehr für die Befüllung des Volumes.
2. **Git-Worktree-Link wird ersetzt.** `replaceLinkedModules` (`src/core/sandbox.ts`) ersetzt im Agent-Worktree den `node_modules`-Symlink durch einen leeren Ordner. Das geschieht nur, wenn `.git` im Worktree eine Datei ist und `node_modules` ein Symlink. Projektordner, in denen Menschen arbeiten, bleiben unberührt. Der Link zeigt im Container auf einen Host-Pfad, deshalb würde npm dort scheitern.
3. **Test `git-guard` läuft in einem eigenen Repository.** `src/core/git-guard.test.ts` ruft git im eigenen Test-Repository auf. Im Agent-Container ist `.git` eine Datei, die auf einen Host-Pfad zeigt. Der Test scheiterte dort mit `fatal: gitfile does not point to a valid repository`.

## Wann die Installation läuft (Bedingungen)

Die Installation im Volume startet nur unter diesen Bedingungen:

- Der Worktree hat eine `package.json`. Ohne sie wird nichts installiert.
- Der Stempel `node_modules/.aideation-lock` passt nicht zum Hash der `package-lock.json` (sonst der `package.json`). Passt er, bleibt das Volume unverändert.
- Dann löscht der Worker den Inhalt des Volumes bis auf den Cache und ruft `npm install --ignore-scripts` auf. Installationsskripte laufen nicht, wie bei den Agents.
- Läuft im Volume schon eine Installation, wartet die nächste über eine Sperre (`flock`). Sie prüft danach den Stempel. Das gilt auch, wenn der Worker während einer Installation neu startet.

## Worauf Sie achten müssen

1. **Worker neu starten.** Der Worker muss mit dem neuen Code laufen. Beim Neustart wird das Image `aideation-agent` neu gebaut.
2. **Grüner Lauf in GitHub Actions fehlt.** Das Log des roten Laufs war für die Agents nicht lesbar (`gh` gesperrt, kein Netz). Der Bug gilt erst als behoben, wenn die Jobs `check` und `docker` grün sind. Den Job-Link oder die Ausgabe an den Auftrag hängen.
3. **`tsc: not found` oder `tsx: not found` im Container** bedeutet ein leeres Volume, keinen Testfehler. Der Worker füllt es vor dem nächsten Lauf. Läuft der Befehl trotzdem leer, ist der Worker vermutlich noch alt.
4. **Datenbank-Tests** laufen nur mit `DEV_LOG_TEST_ADMIN_DATABASE_URL`. Ohne diese Variable werden sie übersprungen, und der Lauf gilt trotzdem als grün.

## Prüfstand

Der Stand unten stammt aus dem Entwicklerbericht. Ich (der Handbuch-Autor) habe die Befehle in dieser Sitzung nicht erneut ausgeführt, weil die Shell für mich gesperrt war.

| Befehl | Ergebnis laut Entwicklerbericht |
|---|---|
| `npm run lint` | 0 Fehler, 722 Warnungen |
| `npm run format:check` | in Ordnung |
| `npm run typecheck` | ohne Fehler |
| `npm run test:unit` | 2084 Tests, 2074 bestanden, 0 fehlgeschlagen, 10 übersprungen (Datenbank-Tests ohne `DEV_LOG_TEST_ADMIN_DATABASE_URL`) |

Vor dem Fix scheiterte genau ein Test (der `git-guard`-Test oben). Ein grüner Lauf in GitHub Actions fehlt noch.

## Printscreens

Entfallen. Die Änderung berührt keine Seite der Oberfläche, es gibt also nichts zu zeigen.

## Offene Punkte

1. Roter und grüner GitHub-Actions-Lauf sind nicht belegt.
2. Image `aideation-agent` ist nicht neu gebaut und das Volume nicht befüllt. `docker build` ist für Agents gesperrt. Das erledigt der Worker-Neustart.
3. Die Prüfzahlen oben sind nicht von mir nachgeprüft.
