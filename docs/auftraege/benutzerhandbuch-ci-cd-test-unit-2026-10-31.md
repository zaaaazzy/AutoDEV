# Benutzerhandbuch: `npm run test:unit` im Agent-Container (Auftrag 788ec856)

Stand: 11.11.2026 (Ergänzung zum Stand 31.10.2026). Der Auftragsbericht steht in `docs/auftraege/ci-cd-test-unit-2026-10-31.md`.

Betroffen sind Entwickler und Betreiber. Es gibt keine neue Seite, keine neue Schaltfläche und keine geänderte Oberfläche. Deshalb entfallen die Printscreens; es gibt in der Oberfläche nichts zu zeigen.

## Was sich ändert

1. **Abhängigkeiten im Agent-Volume.** Das `node_modules`-Volume des Projekts (`aideation_worker_modules`) befüllt der Worker selbst, in `ensureDependencies` (`src/core/sandbox.ts`). Ein Aufruf, der nur liest, befüllt es nicht.
2. **Git-Worktree-Link wird ersetzt.** `replaceLinkedModules` (`src/core/sandbox.ts`) ersetzt im Agent-Worktree den `node_modules`-Symlink durch einen leeren Ordner. Das geschieht nur, wenn `.git` im Worktree eine Datei ist (Git-Worktree) und `node_modules` ein Symlink. Projektordner, in denen Menschen arbeiten, bleiben unberührt. Der Link zeigt im Container auf einen Host-Pfad, deshalb würde npm dort mit ENOTDIR scheitern.
3. **npm-Cache.** Die Installation im Volume nutzt `--cache node_modules/.cache/npm`; der Ordner `.cache` bleibt beim Neuaufbau des Volumes erhalten. Befehle im Container laufen mit `npm_config_cache=/tmp/npm-cache` (`src/core/sandbox-base.ts`). Der Grund: `/tmp` ist für jede UID beschreibbar, ein `~/.npm` aus dem Image-Build gehört root und lässt `npx` mit EACCES scheitern.
4. **Test `git-guard` läuft in einem eigenen Repository.** `src/core/git-guard.test.ts` ruft git im eigenen Test-Repository auf. Laut Entwicklerbericht scheiterte der Test im Agent-Container, weil `.git` dort auf einen Host-Pfad zeigt. Die Ursache im Container ist nicht nachvollzogen (siehe Offene Punkte).

## Wann die Installation läuft (Bedingungen)

Die Installation im Volume startet nur, wenn alle diese Bedingungen zutreffen:

- Der Worktree hat eine `package.json`. Ohne sie wird nichts installiert.
- Der Lauf schreibt in den Worktree. Lesende Läufe (Rollen mit `:ro`, z. B. Visionär oder Problemanalyse), Läufe ohne Worktree und Läufe mit `dependencies: false` installieren nichts (`runInSandbox`, `src/core/sandbox.ts`, Zeile 131).

Ist die Bedingung erfüllt:

- Der Stempel-Hash wird aus `package-lock.json` gebildet, ohne Lockfile aus `package.json`. Stimmt der Stempel `node_modules/.aideation-lock` schon, bleibt das Volume unverändert (`dependencyStamp`, `src/core/sandbox-base.ts`).
- Sonst löscht der Worker den Inhalt des Volumes bis auf `.cache` und die Sperrdatei und ruft `npm install --ignore-scripts` auf. Installationsskripte laufen dabei nicht.
- Läuft im Volume schon eine Installation, wartet die nächste über eine Sperrdatei (`flock`) und prüft danach den Stempel. Gleiche Installationen im selben Worker teilen sich ein Ergebnis.
- Schlägt die Installation fehl, startet der Befehl nicht. Die Meldung nennt das Volume und den Exit-Code.

## Worauf Sie achten müssen

1. **Worker neu starten.** Der Worker muss mit dem neuen Code laufen. Der Neustart baut nur das Image des Dienstes `worker` (`docker compose build worker`, `src/runner/system-restart.ts`). Das Image `aideation-agent` baut er **nicht**.
2. **Image `aideation-agent` von Hand bauen.** Das geht im AIdeation-Ordner mit `docker build -t aideation-agent -f deploy/agent/Dockerfile .`. Agents haben dafür keine Berechtigung; das muss ein Mensch tun. Der Hinweis dazu steht auch in der Meldung der Sandbox (`src/core/sandbox-base.ts`).
3. **Grüner Lauf in GitHub Actions fehlt.** Der Bug gilt erst als behoben, wenn die Jobs `check` und `docker` in `.github/workflows/ci.yml` grün sind. Das Log des roten Laufs war für die Agents nicht lesbar (`gh` gesperrt, kein Netz). Den Job-Link oder die Ausgabe an den Auftrag hängen.
4. **`tsc: not found` oder `tsx: not found` im Container** bedeutet ein leeres Volume, keinen Testfehler. Der Worker füllt es vor dem nächsten Lauf. Läuft der Befehl trotzdem leer, ist der Worker vermutlich noch alt oder das Image nicht neu gebaut.
5. **Datenbank-Tests** laufen nur mit `DEV_LOG_TEST_ADMIN_DATABASE_URL`. Ohne diese Variable werden sie übersprungen; der Lauf endet trotzdem grün, die Zeile „übersprungen“ im Bericht zeigt es.
6. **Tests, die git aufrufen,** brauchen im Agent-Container ein eigenes Test-Repository als `cwd`, weil `.git` dort auf den Host zeigt.

## Prüfstand

Die Zahlen unten stammen aus den Entwicklerberichten. Der Handbuch-Autor hat die Befehle nicht selbst ausgeführt, weil in seiner Sitzung keine Shell verfügbar war.

| Befehl | Ergebnis laut Entwicklerbericht (Stand 11.11.2026) |
|---|---|
| `npm run lint` | 0 Fehler, 722 Warnungen (Stand 31.10.) |
| `npm run format:check` | in Ordnung |
| `npm run typecheck` | ohne Fehler |
| `npm run test:unit` | 2096 Tests, 2086 bestanden, 0 fehlgeschlagen, 10 übersprungen (nur Datenbank-Tests ohne `DEV_LOG_TEST_ADMIN_DATABASE_URL`) |

Vor dem Fix scheiterte der `git-guard`-Test. Ein grüner Lauf in GitHub Actions fehlt noch.

### Nachtrag 11.11.2026: Merge in den Sprint

Der Merge war an einem Konflikt in `src/core/sandbox.ts` gescheitert. Sprint 30 hat Konstanten und Hilfen nach `src/core/sandbox-base.ts` verschoben; `sandbox.ts` bleibt der Einstieg. Für Anwender ändert sich dadurch nichts.

Der Gegentest zeigt: Ein neuer Testfall („Projektordner mit `.git` als Ordner bleibt ein node_modules-Symlink“, `src/core/sandbox.test.ts`) scheitert auf dem Stand vor dem Fix wie erwartet. Der Tester hat zwei weitere Testfälle als Doppel bestehender Tests entfernt oder zusammengeführt. Die Prüfung dieses Punkts liegt noch offen (siehe unten).

## Printscreens

Entfallen. Die Änderung berührt keine Seite der Oberfläche.

## Offene Punkte

1. **GitHub Actions nicht belegt.** Weder ein roter noch ein grüner Lauf liegt im Repo vor. Der Bug darf erst nach grünen Jobs `check` und `docker` geschlossen werden.
2. **Image und Volume.** Das Image `aideation-agent` ist nicht neu gebaut. Das Volume wird erst nach dem Neubau und dem nächsten Lauf befüllt. Beides muss ein Mensch auslösen.
3. **Merge und Git im Container.** Ob der Merge-Fehler vom 11.11. behoben ist, ist nicht belegt; im Container geht git nicht, weil `.git` auf einen Host-Pfad zeigt.
4. **Ursache des `git-guard`-Fehlers** im Container ist nicht nachvollzogen. Die Zeile „gitfile does not point to a valid repository“ stammt aus dem Entwicklerbericht.
5. **Zahlen nicht nachgeprüft.** Die Testzahlen (2084/2074 vom 31.10. und 2096/2086 vom 11.11.) sind aus den Berichten übernommen und nicht selbst ausgeführt.
