# Folgeaufträge aus Doku-Abschnitten vorschlagen

Auftrag `2150f8c0-49df-43a1-8e71-0d16a805ee87`.

## Was sich geändert hat

Nach einem erfolgreichen Dokumentierer-Schritt liest AIdeation die neue Auftragsdoku. Aus den Abschnitten „Offen“, „TODO“, „Bekannter Befund“ und „Folgeauftrag“ entstehen Vorschläge für Bugs oder Ideen. Sie stehen im Auftrag unter „Vorschläge aus der Doku“. Erst „Annehmen“ legt einen Bug oder eine Idee an.

## Ablauf

1. `afterStep` (`src/runner/runner-settle.ts`) speichert die Doku (`saveOrderDoc`) und ruft danach `proposeFromDoc` auf. `afterStep` läuft nur bei bestandenem Schritt (`runStep` in `runner-steps.ts`), ein gescheiterter Dokumentierer erzeugt also keine Vorschläge.
2. `proposeFollowUps` (`src/runner/follow-up-proposals.ts`) liest den Doku-Eintrag (`docs`, `kind = 'order'`) samt ID und parst den Text mit `parseFollowUpSections`.
3. Gleiche Titel innerhalb der Doku werden zusammengefasst (`uniqueEntries`). Titel mit Ähnlichkeit ≥ 0,55 zu offenen Bugs (`open`, `in_progress`) oder offenen Ideen (alle Status außer `accepted`, `rejected`) werden verworfen und gezählt (`withoutDuplicates`, nutzt `findDuplicate` aus `src/agent/visionary.ts`).
4. Die übrigen Vorschläge werden in einer Transaktion in `follow_up_proposals` gespeichert (Status `proposed`). `UNIQUE (development_id, title)` verhindert Doppelte bei einem erneuten Dokumentierer-Lauf.
5. Ein Fehler wird mit Auftrags-ID per `console.error` ins Worker-Log geschrieben. Status, Tokens und Kosten des Schritts bleiben unverändert, der Auftrag läuft weiter.

## Erkennung

- Abschnitt nur als Überschrift (`#` bis `######`) oder als Zeile, die mit `**Stichwort…:**` bzw. `- **Stichwort…:**` beginnt (auch `**Stichwort**:`).
- Stichwörter (Anfang des Labels, Groß-/Kleinschreibung egal): „Offen“ (auch „Offene …“), „TODO“/„TODOs“, „Bekannter Befund“ (auch „Bekannte Befunde“), „Folgeauftrag“/„Folgeaufträge“. „Offenlegung“ zählt nicht.
- Labels mit „geklärt“, „erledigt“ oder „behoben“ (ohne „nicht“ davor) zählen nicht, z. B. „**Offener Prüfpunkt geklärt:**“. „**Bekannter Befund, nicht behoben:**“ zählt.
- Unter einer Überschrift ist jeder Listenpunkt ein Eintrag (eingerückte Zeilen gehören dazu), ohne Liste jeder Absatz. Unterüberschriften werden eigene Einträge. Der Abschnitt endet an der nächsten Überschrift gleicher oder höherer Ebene.
- Bei einem fetten Label ist der Text dahinter der Eintrag. Mit Listenpunkt gehören nur eingerückte Folgezeilen dazu, ohne Listenpunkt alles bis zur nächsten Leerzeile. Ein Label ohne Text dahinter nimmt die folgende Liste.
- Codeblöcke werden übersprungen. Platzhalter wie „Keine.“ ergeben keinen Vorschlag.
- Titel: erster Satz ohne Markdown, gekürzt auf 80 Zeichen (`TITLE_MAX`, dieselbe Grenze wie bei `POST /bugs`). Das liegt unter der geforderten Obergrenze von 180. Die Beschreibung ist der ganze Eintrag.
- Typ: „Bekannter Befund“ ergibt einen Bug. Die anderen Abschnitte ergeben eine Idee, außer der Titel nennt einen Fehler („Fehler“, „Bug“, „scheitert“, „bricht“, „falsch“, „kaputt“, „Absturz“, „stürzt“).

## Datenbank

Migration 29 `folgevorschlaege-aus-doku` (`src/db/migrations.ts`; zuerst als 27 geplant, 27 und 28 belegte Sprint 30). Das Basisschema ist per Prüfsumme gesperrt, darum steht die Tabelle dort nicht. Spalten: `project_slug`, `development_id`, `doc_id`, `kind` (`bug`/`idea`), `section`, `title`, `description`, `status` (`proposed`/`accepted`/`dismissed`), `result_id`, `decided_by`, `decided_at`, `created_at`. Die CHECKs erlauben genau die Werte, die der Code schreibt (`FOLLOW_UP_STATUS`, `FOLLOW_UP_KIND` in `src/core/status.ts`). Die Migration ist idempotent (`IF NOT EXISTS`).

`bugs.development_id` wird bei angenommenen Bugs bewusst nicht gesetzt. Sonst käme der Bug per Trigger auf den Friedhof, sobald der Auftrag erledigt ist. Die Verbindung läuft über `follow_up_proposals.result_id`.

## API

`src/api/follow-up-proposals.ts`, Datenzugriff in `src/db/follow-up-proposal-repository.ts`:

- `GET /api/development/:id/follow-up-proposals` liefert nur Vorschläge mit Status `proposed` (Mandant `development`).
- `POST /api/follow-up-proposals/:id/accept` braucht das Recht „Planung“ (Mandant `follow-up-proposals`, neu in `tenancy.ts`). In einer Transaktion: `UPDATE … WHERE status = 'proposed'`, dann Bug (`insertProposalBug` in `src/db/bugs-repository.ts`: `INSERT INTO bugs`, `source = 'agent'`, ohne Sprint) bzw. Idee (`insertProposalIdea`), dann `result_id`. Ein zweiter oder gleichzeitiger Klick bekommt 409 und legt nichts an. Die Kategorie stuft `afterBugCreated` nach dem Commit ein.
- `POST /api/follow-up-proposals/:id/dismiss` braucht ebenfalls „Planung“ und setzt `dismissed`. Ein schon entschiedener Vorschlag ergibt 409, ein unbekannter 404.

## Oberfläche

`OrderProposalsComponent` (`frontend/src/app/features/development/order-proposals.component.ts`) steht in der Auftragsansicht. Sie erscheint bei erledigten Aufträgen, bei Aufträgen in Freigabe und immer dann, wenn es offene Vorschläge gibt. „Annehmen“ und „Verwerfen“ sehen nur Nutzer mit `auth.can('plan')`. Ohne Vorschläge steht dort „Keine offenen Vorschläge.“

## Tests

`src/runner/follow-up-proposals.test.ts`:

- Parser mit dem Abschnitt „**Bekannter Befund, nicht behoben:**“ aus `docs/agent-tests.md`
- Überschriften und Labels
- Fliesstext, Codeblöcke und erledigte Labels
- Dubletten innerhalb der Doku
- Ähnlichkeitsschwelle
- `afterStep` legt keinen Bug und keine Idee an, ein Fehler bricht nicht ab
- Mit Datenbank der ganze Ablauf: Dubletten nur gegen offene Einträge, zweiter Lauf, gleichzeitiges Annehmen (200/409), Verwerfen, Liste nur `proposed`

`roles.test.ts` prüft die Rechte der neuen Routen. In `migrations.test.ts` hängen die Versionslisten nicht mehr an der letzten Migration.

## Offen

- **Offen:** Zwei der drei Belege aus der Idee (`docs/agents-loeschen-und-umbenennen-git-rm-mv-2026-10-28.md`, `docs/agenten-per-drag-and-drop-zwischen-phasen-2026-10-28.md`) stehen nur im Fliesstext. Der Parser erkennt sie bewusst nicht. Ob der Dokumentierer-Prompt Befunde künftig als eigene Abschnitte schreiben soll, ist noch zu entscheiden.
