# PATCH /docs/:id umgeht Vier-Augen-Prinzip und Schreibschutz

Auftrag a3d14567 (Bugfix, Schwere mittel, 25.10.2026). Sprint 23. Gefunden bei der Gesamtprüfung vom 21.10.2026.

## Ursache

`PATCH /api/docs/:id` (Rolle „editor“) schrieb Titel und Inhalt direkt in `docs`. Es gab keine Revision, keine Freigabe durch eine zweite Person und keine Prüfung der Dokumentart. Damit ließen sich auch `repo`- und `request`-Dokumente ändern. Ein bereits vergebener Titel verletzte `docs_unique_title_idx` und endete als HTTP 500. Die Oberfläche nutzte die Route nicht.

## Umsetzung

- **Route entfernt** (`src/api/docs.ts`): Es gibt kein `PATCH /docs/:id` mehr. An der Stelle steht ein Kommentar, der auf den Weg über `POST /docs/:id/revisions` verweist. Dort gelten Vier-Augen-Prinzip, Schreibschutz für `repo`/`request` und die Titelprüfung (409) unverändert (`src/api/doc-revisions.ts`).
- **Regressionstest** (`src/api/docs-post.test.ts`): Ein Redakteur (`docs`, `editor`, ohne admin) schickt `PATCH /api/docs/<id>` über den echten Router mit `routeGuard`. Erwartet wird 403, 404 oder 405 und kein `UPDATE docs`. Danach prüft der Test, dass `POST /docs/:id/revisions` weiter 201 liefert, eine Zeile in `doc_revisions` anlegt und das Dokument nicht verändert. Der Pool-Stub liefert bei einem `UPDATE docs` ein Dokument zurück, die Route würde also mit 200 durchlaufen und der Test scheitern.
- **Rollen** (`src/api/roles.ts`): keine Änderung nötig. „Redaktion“ beschreibt nur noch das Prüfen, Freigeben und Ablehnen eingereichter Änderungen sowie das Löschen.

## Geänderte Dateien

- `src/api/docs.ts`
- `src/api/docs-post.test.ts` (1 neuer Test)

Commit `4d727285`.

## Worauf zu achten ist

- **Test nicht gelaufen:** Entwickler und Dokumentierer konnten ihn nicht ausführen (fehlende Freigabe). Der Tester soll gezielt `npx --no-install tsx --test src/api/docs-post.test.ts` starten, nicht die ganze Suite.
- **Alte Hinweise:** `PATCH /docs/:id` steht in `src`, `docs`, `README.md` und `frontend/src` nirgends mehr, nur im Kommentar und im Test.
- **Offen, eigener Auftrag nötig:** `DELETE /docs/:id` hat dasselbe Rollenproblem. Jeder Redakteur kann jedes Dokument löschen, auch `repo`- und `request`-Dokumente, ohne zweite Person und ohne Prüfung der Dokumentart. Bewusst nicht Teil dieses Auftrags.
- **Schwäche im Nachbartest:** Der POST-Test in derselben Datei prüft nur `201 || 409`. Er ist schwächer als der neue Test.

## Sprint 23

| Auftrag | Zustand | Details |
| --- | --- | --- |
| a3d14567 PATCH /docs/:id umgeht Vier-Augen-Prinzip | umgesetzt, Test wartet auf Tester | Route entfernt, Regressionstest ergänzt |

## Anfrage / TODO

- Neuer Auftrag: `DELETE /docs/:id` auf Dokumentart und Vier-Augen-Prinzip prüfen (Bereich backend, Schwere mittel).
- Test `docs-post.test.ts` ausführen und Ergebnis bestätigen.
