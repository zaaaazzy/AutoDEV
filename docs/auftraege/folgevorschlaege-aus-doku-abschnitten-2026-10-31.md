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

## Benutzerhandbuch: Vorschläge aus der Doku

### Wo es steht

Im Auftrag gibt es den aufklappbaren Bereich „Vorschläge aus der Doku“. Er erscheint bei erledigten Aufträgen, bei
Aufträgen in der Freigabe und sobald offene Vorschläge vorliegen. Neben dem Titel steht die Anzahl der offenen
Vorschläge. Ist der Bereich aufgeklappt, liegt mindestens ein Vorschlag vor.

### Was ein Vorschlag ist

Nach einem erfolgreichen Dokumentierer-Schritt liest AIdeation die neue Auftragsdoku. Jeder Eintrag aus den Abschnitten
„Offen“, „TODO“, „Bekannter Befund“ und „Folgeauftrag“ wird ein Vorschlag. Jeder Vorschlag zeigt:

- **Art:** „Bug“ oder „Idee“. Ein Eintrag aus „Bekannter Befund“ wird immer ein Bug. Ein Eintrag aus den anderen
  Abschnitten wird ein Bug, wenn sein Titel ein Fehlerwort nennt (Fehler, Bug, scheitert, bricht, falsch, kaputt,
  Absturz, stürzt). Sonst wird er eine Idee.
- **Titel:** der erste Satz des Eintrags, ohne Markdown, höchstens 80 Zeichen.
- **Abschnitt:** „aus „…““, damit man sieht, woher der Vorschlag stammt.
- **Beschreibung:** der ganze Eintrag, aufklappbar im Text.

Erkannt wird ein Abschnitt nur, wenn er als Überschrift (`#` bis `######`) oder als Zeile mit einem fetten Label steht,
etwa `**Offen:**` oder `- **TODO:**`. Dieselben Wörter mitten in einem Satz zählen nicht. Dazu gelten diese Regeln:

- Ein Label mit „geklärt“, „erledigt“ oder „behoben“ (ohne „nicht“ davor) ist erledigt und ergibt keinen Vorschlag.
  „**Bekannter Befund, nicht behoben:**“ dagegen ergibt einen.
- Platzhalter wie „Keine.“ oder „Nichts offen.“ ergeben keinen Vorschlag.
- Einträge in Codeblöcken werden übersprungen.
- Gleiche Titel innerhalb einer Doku ergeben nur einen Vorschlag.

**Bekannte Lücke:** Befunde, die nur im Fließtext stehen und keinen eigenen Abschnitt haben, erkennt AIdeation nicht.
Zwei der drei Belege aus der Idee sind so geschrieben. Der Dokumentierer-Prompt bleibt in diesem Auftrag unverändert.

### Dubletten

Ein Vorschlag wird nicht gespeichert, wenn sein Titel zu einem offenen Bug oder einer offenen Idee mindestens
0,55 Ähnlichkeit hat. Als offen gelten Bugs mit Status `open` oder `in_progress` und Ideen mit jedem Status außer `accepted` und `rejected`.
Ein Treffer mit einem angenommenen oder abgelehnten Eintrag zählt nicht als Dublette. Dann entsteht der Vorschlag.

### Annehmen und Verwerfen

- **Annehmen als Bug** legt genau einen Bug an. Er hat die Quelle „Agent“ und keinen Sprint. Danach wird er wie jeder
  andere Bug eingeordnet (Kategorie, siehe Abschnitt 4 im Anwendungshandbuch).
- **Annehmen als Idee** legt genau eine Idee an.
- **Verwerfen** legt nichts an. Der Vorschlag verschwindet aus der Liste.
- **Doppelklick:** Der zweite Klick legt nichts mehr an. Er bekommt die Meldung „Der Vorschlag wurde bereits angenommen
  oder verworfen.“, und die Liste lädt neu.
- **Rechte:** Die Knöpfe sieht nur, wer das Recht „Planung“ hat. Alle anderen sehen den Hinweis „Annehmen und Verwerfen
  braucht das Recht „Planung“.“ Die API lehnt Nutzer ohne dieses Recht ebenfalls ab (403).
- **Leere Liste:** „Keine offenen Vorschläge.“ Das heißt: Der Dokumentierer hat keine passenden Abschnitte gefunden,
  oder die Vorschläge sind schon entschieden.

### Was nicht passiert

- AIdeation legt nie selbst einen Bug oder eine Idee an. Das geschieht nur nach „Annehmen“.
- Scheitert der Dokumentierer-Schritt, entsteht kein Vorschlag. Scheitert der Erkennungsschritt selbst, bleibt der
  Auftrag unverändert, und der Fehler steht im Worker-Log. Auf der Oberfläche erscheint er nicht.
- Ein angenommener Bug entsteht ohne Sprint. Die Vorschläge selbst haben keine Sprint-Zuordnung.

### Printscreens

**Nicht erstellt.** In dieser Sitzung habe ich keine Aufnahmen gemacht. Die Oberfläche braucht eine laufende App mit
Datenbank und einen Browser. Für einen Menschen auf einem Host mit laufender App sind diese Aufnahmen nötig:

1. Auftrag nach dem Dokumentierer: aufgeklappter Bereich „Vorschläge aus der Doku“ mit Bug- und Idee-Eintrag, Knöpfe
   „Annehmen als …“ und „Verwerfen“ (Recht „Planung“).
2. Gleicher Auftrag mit einem Nutzer ohne Recht „Planung“: Hinweis statt Knöpfe.
3. Auftrag ohne offene Vorschläge: „Keine offenen Vorschläge.“
4. Nach „Annehmen als Bug“: Liste ohne den angenommenen Vorschlag.
5. Bug-Liste: neuer Bug, Quelle „Agent“, ohne Sprint.
6. Ideation: neue Idee aus einem Vorschlag.
7. Zweiter Klick auf „Annehmen“ nach einer Aktualisierung: Meldung „bereits angenommen oder verworfen“.
