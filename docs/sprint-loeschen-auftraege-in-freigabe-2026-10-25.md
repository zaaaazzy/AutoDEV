# Sprint abschliessen und löschen: Aufträge in Freigabe berücksichtigen

Auftrag d0502c32 (Bugfix, 25.10.2026). Sprint 23. Gefunden im Code-Review vom 21.10.2026 (Stand `a4971e9`).

## Ursache

Gemeldet war, dass Abschluss, Live-Schalten und Löschen nur Aufträge `in_progress` prüfen. Das stimmt nur für das Löschen.

- **Abschluss und Live-Schalten:** Sie blockieren Aufträge in Freigabe schon, über die Zählung `waiting` in `src/api/sprints.ts` (Zeilen 178–201). Dafür war keine Änderung nötig.
- **Löschen:** Die Regel `deletable` prüfte nur `status = 'in_progress'`. Ein Auftrag in `approval` hielt das Löschen nicht auf. Nach „Freigeben“ hätte der Worker ohne Sprint gemergt.

## Umsetzung

- **`DELETE /projects/:slug/sprints/:id`** (`src/api/sprints.ts`): `deletable` zählt Aufträge mit `status IN ('in_progress', 'approval')`. Die 409-Meldung lautet jetzt: „Nur geplante, abgeschlossene oder abgebrochene Sprints ohne Git-Sicherung und ohne Aufträge, die laufen oder auf Freigabe warten, lassen sich löschen.“
- **Keine gemeinsame Konstante:** Der Abschluss braucht `running` und `waiting` getrennt, um zwei verschiedene Meldungen auszugeben. Eine Konstante hätte nur eine Stelle bedient.
- **Unverändert:** der Merge-Pfad, „Wieder einplanen“ und „Erneut versuchen“.

## Geänderte Dateien

- `src/api/sprints.ts`
- `src/api/sprint-complete.test.ts` (neue Tests am Ende)
- `docs/workflows.md` (Absatz „Abschließen und Löschen mit offenen Aufträgen“)

## Tests

`src/api/sprint-complete.test.ts`, gegen die echte Test-Datenbank:

- Abschluss mit Auftrag in Freigabe: 409, kein Bericht, kein Git-Sync.
- DELETE mit Auftrag in Freigabe oder in Arbeit: 409. Der Sprint bleibt bestehen, geplante Aufträge bleiben geplant.
- Gegenprobe ohne solche Aufträge: Abschluss 200 (mit Bericht und Git-Sync), Löschen 204 (geplante Aufträge gehen ins Backlog).
- Der neue Test scheiterte vor dem Fix mit „DELETE mit Auftrag in approval – 204 !== 409“.
- `npm test` lief komplett grün (1494 Tests), ohne Abdeckungs-Flags.

## Worauf zu achten ist

- Ändert sich die Statusliste, müssen Abschluss (`running`/`waiting`) und Löschen (`deletable`) beide angepasst werden.
- Tests ohne `--experimental-test-coverage` starten. `npx --no-install tsx --test …` verlangt in dieser Umgebung eine Freigabe, daher `npm test` nutzen.
