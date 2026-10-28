# Tester: Geheimnisschutz – Platzhalter umgehen die Sperre (Auftrag f4582d2b)

**Status:** behoben und geschlossen (Bug konnte nicht über die API angelegt werden, `curl` ist für Agents gesperrt; bitte im Bug-Board nachtragen).

## Fehler
`secretReadProblem` und `bashProblem` prüften nur Namen. Platzhalter nannten das Geheimnis nicht und kamen durch:

- `Grep` mit `glob: ".en?"`, `".e[n]v"`, `".{e,x}nv"`, `"*.pe?"`, `"*.k[e]y"`
- `Glob` mit `.en*`, `.npm?c`
- Shell: `cat .en?`

Folge: `.env`-Werte hätten im Klartext in `chat_messages` landen können.

## Test (vorher rot)
`src/agent/secret-read-bypass.test.ts`: 2 Tests, beide rot (`glob: ".en?"` ergab `null`, `cat .en?` ergab `null`).

## Lösung
- `src/agent/tool-paths.ts`: `expandBraces`, `secretGlob`, `secretSegment`. Ein Segment mit `*`, `?` oder `[…]` zählt als Geheimnis, wenn es einen Beispielnamen (`.env`, `*.pem`, `.npmrc` …) trifft und keinen gewöhnlichen Namen (`x`, `a.ts`, `a.md`). `*`, `**` und `*.md` bleiben erlaubt.
- `src/agent/agent-guard.ts`: `secretPart` nutzt `secretSegment` (auch verschachtelte Klammern); `bashProblem` sperrt Wörter mit solchen Segmenten.

## Ergebnis nachher
`npm test`: 1450 bestanden, 1 fehlgeschlagen. `npm run typecheck` ist sauber. Die neuen Tests sind grün.

## Offen (nicht Teil dieses Auftrags)
- `src/core/shutdown.test.ts` „neu vergebene PID (andere Startzeit) wird nicht angefasst“ ist rot (`killed` statt `reused`). `src/core` ist nicht geändert; vermutlich Umgebung (macOS-Startzeit von `ps`). Eigener Bug nötig.
- Grep über einen ganzen Ordner ohne `glob` prüft der Wächter weiterhin nicht Datei für Datei; dort gilt nur `permissions.deny`.
