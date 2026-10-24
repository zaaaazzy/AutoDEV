# Seiten-Vorlage: so ist eine Seite gebaut

Vorbild ist die Bugs-Seite (Stand 24.10.2026, Branch `fix/bugs-sicherheit`): API `src/api/bugs.ts`, Oberfläche
`frontend/src/app/features/bugs/`. Neue und überarbeitete Seiten folgen diesen Punkten; die Prüfliste am Ende geht
man vor dem Pull Request durch.

## API (Route)

1. **Rechte an der Route deklarieren:** `access({ role, tenant })` als erster Handler. Lesen braucht keine Rolle,
   Schreiben die kleinste passende (`plan`, `run`, …). Fehlt die Deklaration, gilt nur Administration.
2. **Eingaben über eine Feldliste prüfen:** `FieldSpec` mit Parsern (`parseTitle`, `parseOption`, `parseLongText`,
   `parseNullableUuid` …) und `parseFields`. Unbekannte Felder fallen weg. Fehler mit `invalidInput(...)` beantworten,
   damit die Oberfläche die Meldung am richtigen Feld zeigt (`{ field, message }`).
3. **IDs prüfen, bevor die Datenbank sie sieht:** `isUuid`, `parseProjectSlug`. Unbekannt oder ungültig = 404 bzw.
   400, nie 500.
4. **SQL nur mit Parametern.** Spalten- und Tabellennamen kommen aus Code-Konstanten (`buildUpdate`), nie aus Eingaben.
5. **Bezüge im selben Projekt halten:** Ein Sprint, Auftrag o. Ä. aus dem Body muss zum Projekt des Eintrags gehören
   (`relatedResourceBelongsToProject` oder `JOIN … ON project_slug`).
6. **Zustandswechsel atomar:** Bedingung ins `UPDATE … WHERE` schreiben (z. B. `approved_at IS NULL`) statt erst zu
   lesen und dann zu schreiben; 409, wenn sich der Zustand inzwischen geändert hat.
7. **Löschen mit Folgen bedenken:** Was hängt am Eintrag (Aufträge, Bilder)? Läuft gerade etwas, 409 mit Hinweis.
   Mehrere Schritte in einer Transaktion.
8. **Fremder Text (Betrieb, GitHub) erreicht Agents nur nach Freigabe** und immer eingefasst
   (`fencedBugDescriptionSql`, `EXTERNAL_TEXT_START`).

## Oberfläche (Komponente)

1. **Rechte wie in der API:** `mayPlan = computed(() => auth.can('plan'))` usw. Bedienelemente ohne Recht nicht
   anzeigen; stattdessen den Wert als Text. Die API bleibt die eigentliche Grenze.
2. **Rückfragen über `ConfirmService`,** nie `globalThis.confirm`. Löschen mit `danger: true`; Aktionen, die sich in
   der Oberfläche nicht rückgängig machen lassen (z. B. Friedhof), immer bestätigen lassen. Bei Abbruch die Auswahl
   zurücksetzen.
3. **Formulare:** `FieldErrors` je Formular, Pflichtfelder vor dem Absenden prüfen (`require` + `focusField`),
   API-Feldfehler mit `take(error, form)` ans Feld. Fehler mit `role="alert"` und `aria-invalid` am Feld. Absenden
   während `busy()` sperren.
4. **Nur Geändertes senden** (`bugChanges`): Unveränderte Felder überschreiben sonst, was ein Agent inzwischen
   geändert hat. Die Logik liegt in einer reinen Funktion mit Spec (`bug-form.ts`).
5. **Auswahllisten aus einer Quelle:** gleiche Reihenfolge überall (`SEVERITIES`), nur gültige Ziele
   (`selectableSprints`: keine abgeschlossenen Sprints, der aktuelle bleibt sichtbar). `null` statt `''` für „kein …“.
6. **Deep-Link `#<seite>/<id>`:** `store.focusId()` öffnet den Eintrag und scrollt hin; Aufklappen schreibt die
   Adresse mit `history.replaceState` nach, damit sich der Eintrag als Link teilen lässt.
7. **Texte aus Daten nie selbst als HTML bauen.** Interpolation `{{ }}` escaped. Für Markdown die `markdown`-Pipe,
   für eigenes HTML `escapeHtml` und zur Nachbearbeitung `replaceInText` aus `shared/html.ts`.
8. **Dialoge mit `<app-modal>`,** Farben als Token in `01-base.css`, Styles in die Bereichsdatei (siehe
   [styles-nach-bereich-2026-10-23.md](styles-nach-bereich-2026-10-23.md)).

## Tests

- **API gegen PostgreSQL** (`withMigratedDatabase`, `serveRoutes`): jedes Feld ungültig → 400 mit `field`, fremde
  IDs → 404, Bezüge aus anderem Projekt → 400, Rechte über `requiredRole`, Missbrauchsfälle und gleichzeitige
  Anfragen. Vorbild: `src/api/bugs.test.ts`.
- **Reine Logik der Oberfläche** als Spec neben der Datei (`bug-form.spec.ts`).
- **E2E** (`e2e/app.spec.ts`, Desktop und Handy): Deep-Link, eingeschleustes HTML wird Text, Feldfehler, gesendeter
  Body (`waitForRequest` + `postDataJSON`), Rückfragen, eine Rolle ohne Schreibrecht.
- **Gegenprobe:** Neue Sicherheitstests einmal gegen den alten Stand laufen lassen; sie müssen dort scheitern.

## Prüfliste vor dem Pull Request

- [ ] Jede neue Route hat `access(...)`; schreibende Routen die kleinste nötige Rolle.
- [ ] Alle Body-Felder laufen durch eine `FieldSpec`; Fehler nennen das Feld.
- [ ] Keine Eingabe landet unparametrisiert im SQL.
- [ ] Zustandswechsel und Löschen sind atomar und melden Konflikte mit 409.
- [ ] Bedienelemente folgen den Rechten; Rückfragen über `ConfirmService`.
- [ ] Formulare zeigen Fehler am Feld und senden nur Geändertes.
- [ ] Kein `[innerHTML]` ohne `markdown`-Pipe bzw. `escapeHtml`.
- [ ] API-Test, Spec und E2E decken die Punkte oben ab; `npm test`, `npm run typecheck`, `npm run lint`,
      `npm run format:check` sind grün.
