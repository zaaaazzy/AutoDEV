# Benutzerhandbuch: `npm run test:unit` im Agent-Container (Auftrag 788ec856)

Stand: 31.10.2026. Der Auftragsbericht steht in `docs/auftraege/ci-cd-test-unit-2026-10-31.md`, die Risiken in `docs/risiken/ci-cd-test-unit-2026-10-31.md`. Betroffen sind nur Entwickler und Betreiber. Es gibt keine neue Seite und keine neue Schaltfläche.

## Was sich ändert

- `npm run test:unit` läuft im Agent-Container jetzt vollständig durch. Der Test `src/core/git-guard.test.ts:92` scheiterte dort mit `fatal: gitfile does not point to a valid repository: /workspace/.git`. Im Container ist `.git` eine Datei, die auf einen Host-Pfad zeigt. Der Test ruft git jetzt im eigenen Test-Repository auf.
- Das `node_modules`-Volume des Projekts füllt der Worker selbst (`ensureDependencies` in `src/core/sandbox.ts`). Es gibt nur diesen einen Weg; die zweite Befüllung per `npm ci` ist entfernt.
- Im Agent-Worktree ersetzt `replaceLinkedModules` den `node_modules`-Symlink nur, wenn `.git` eine Datei ist. Projektordner von Menschen bleiben unberührt.

## Worauf Sie achten müssen

1. **Worker neu starten:** Der Worker muss mit dem neuen Code laufen. Beim Neustart wird das Image `aideation-agent` neu gebaut.
2. **Grüner Lauf in GitHub Actions fehlt:** Das Log des roten Laufs war für Agents nicht lesbar (`gh` gesperrt, kein Netz). Der Bug gilt erst nach einem grünen Lauf der Jobs `check` und `docker` als behoben. Ausgabe oder Job-Link an den Auftrag hängen.
3. **`tsc`/`tsx: not found` im Container** bedeutet ein leeres Volume, keinen Testfehler. Nach dem Neustart füllt der Worker es vor dem Lauf.

## Prüfstand (Container, 31.10.2026)

| Befehl | Ergebnis |
|---|---|
| `npm run lint` | 0 Fehler, 722 Warnungen (bestehende `x!`-Warnungen) |
| `npm run format:check` | in Ordnung |
| `npm run typecheck` | ohne Fehler |
| `npm run test:unit` | 2084 Tests, 2074 bestanden, 0 fehlgeschlagen, 10 übersprungen (Datenbank-Tests ohne `DEV_LOG_TEST_ADMIN_DATABASE_URL`) |

## Offene Punkte

1. Roter und grüner GitHub-Actions-Lauf nicht belegt.
2. Kein Image-Neubau und kein Befüllen des Volumes durch den Agent (`docker build` gesperrt).
3. Einzelne Testdateien liefen nicht getrennt, nur der Gesamtlauf.
4. Printscreens entfallen, da keine Oberfläche betroffen ist.
