# Tester: Gemeinsame Pfad-Richtlinie (Auftrag a034282d)

**Ergebnis:** `npm test` (Build + `tsx --test`): 1454 Tests, 1453 bestanden, 1 rot. Kein Fehler im neuen Code, kein Bug angelegt.

## Geprüft
- `src/agent/path-policy.ts`: eine Liste (`PROTECTED_DIRECTORIES`, `PROTECTED_FILE`, `SECRET_NAME`) und eine Auflösung (`realTarget`, `realPath`, `checkProjectPath`). `agent-guard.ts` (`fileProblem`) und `tool-paths.ts` (`resolveInside`) rufen beide `checkProjectPath` auf. Alte Listen sind entfernt.
- `src/agent/path-policy.test.ts` (grün): dieselbe Tabelle für beide Wächter.
  - Gesperrt: `node_modules`, `.dev-log-backups`, `.npmrc`, `.yarnrc*`, `.pnpmrc`, `.vscode`, Hooks, `.claude`, `.mcp.json`, Geheimnisse.
  - Umgehungen: Groß- und Kleinschreibung, `..`, Symlinks auf gesperrte Ziele, gesperrter Linkname auf harmlosem Ziel.
  - Gegenproben (bleiben erlaubt): `src/node_modules_info.ts`, `docs/node_modules.md`, `docs/npmrc.md` u. a.
  - Außerhalb des Projekts: `../x.ts`, Link nach außen, `/etc/hosts`.
- `chat-rights.test.ts` und `git-hooks.test.ts` sind in dem Lauf grün.

## Roter Test
`src/core/shutdown.test.ts:39` („neu vergebene PID …“): `'killed'` statt `'reused'`. `killOrphan` liefert `'killed'`, wenn `processStartTime` nichts findet (`ps` liefert in der Wächter-Umgebung keine Startzeit). `shutdown.ts` und der Test sind in diesem Auftrag unverändert. Es ist ein Umgebungseffekt, kein Befund zum Auftrag. Einzelwiederholung nicht möglich: `tsx --test <Datei>` verlangt hier eine Freigabe.

## Offen
- Tabelle nicht vor dem Fix rot gesehen (Befehl brauchte Freigabe). Die Tabelle fordert `node_modules` usw. Der alte Claude-Wächter kannte sie nicht, deshalb hätte sie gescheitert.
- Abdeckung nicht messbar (Wächter sperrt `--experimental-test-coverage`).
- `SECRET_NAME` `^\.env` ohne Abschluss ist breit (sperrt z. B. `.environment`); Absicht unklar, kein Fehler.
