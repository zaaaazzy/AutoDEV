# Benutzerhandbuch: Mandanten-Prüfung für ID-Felder

Gilt ab Auftrag 852db391 (30.10.2026). Betrifft alle Stellen, an denen du oder ein Agent eine ID eines Datensatzes angibst: Agenten, Sprints, Aufträge, Bugs, Chat-Verweise, Workflow-Schritte und Freigaben.

## Was sich ändert

Eine ID aus einem anderen Projekt wird nicht mehr übernommen. Die Anfrage wird abgelehnt, bevor etwas gespeichert wird. Vorher war diese Prüfung an einzelnen Stellen vorhanden, teils gar nicht.

Konkret:

- **Ein gemeinsamer Helfer** prüft jede ID gegen das Projekt, zu dem die Anfrage gehört. Der Helfer heißt `assertInProject` und nutzt den Projekt-Slug.
- **Eine Liste aller ID-Felder** (`TENANT_ID_FIELDS` in `src/api/tenant-id-fields.ts`) führt jede Route mit ID-Eingabe auf: Methode, Pfad, Feld, Tabelle und den Fehlercode.
- **Ein Test** liest die registrierten Routen aus. Steht eine Route mit ID-Feld nicht in der Liste, schlägt der Test fehl. Ein neues ID-Feld kann also nicht unbemerkt ohne Prüfung eingeführt werden.

Eine neue Bedienung gibt es nicht. Die Änderung wirkt im Hintergrund.

## Bedingungen

Eine Anfrage wird geprüft, wenn sie eine ID aus dem Pfad oder aus dem Body enthält. Query-Parameter werden nicht geprüft.

| Ort der ID | Fehlercode bei fremder ID | Beispiel |
|---|---|---|
| Body | 400 | `handoffTo` beim Anlegen oder Ändern eines Agenten, `sprintId` bei Bugs, `ids` bei Reihenfolgen |
| Pfad | 404 | `:id` bei Agent-Aktivität, Abbruch eines Agenten, Testfälle eines Testlaufs |
| `developmentId` beim Review-Start | 404 | unverändert, wie bisher |

Weitere Regeln:

- Eine ID mit leerem Wert (`null` oder leere Liste) ist erlaubt. Es gibt dann nichts zu prüfen. Das gilt z. B. für `handoffTo`: `null` bedeutet „kein Empfänger“.
- Wird die Anfrage abgelehnt, bleibt die Datenbank unverändert. Auch Folgeaktionen wie Git-Sync, Trigger oder Folgeaufträge laufen dann nicht.
- Bestehende Fehlercodes bleiben. Ein Statusschutz (409) wird nicht durch 400 ersetzt.
- Die Rechte deiner Rolle werden nicht verändert. Wer vorher nicht schreiben durfte, darf es auch jetzt nicht (Tests in `access.test.ts`).

## Was du siehst

| Situation | Was passiert |
|---|---|
| Du wählst in der Oberfläche einen Agenten, Sprint oder Auftrag aus, der zum Projekt gehört | Wie bisher. Die Auswahl wird gespeichert. |
| Eine Anfrage nennt eine ID aus einem anderen Projekt (z. B. über eine API-Anfrage) | Die Anfrage wird mit 400 oder 404 abgelehnt. Die Antwort enthält eine Meldung in `message`. Der Wortlaut ist je Route verschieden, z. B. „Sprint gehört zu einem anderen Projekt.“ oder „Agent gehört nicht zum Projekt.“ |
| Die Anfrage ist abgelehnt | Nichts ist geändert: kein neuer Auftrag, kein neuer Bug, keine geänderte Reihenfolge. |

Ob die Oberfläche fremde IDs überhaupt anbietet, ist in diesem Lauf nicht geprüft. Die Ablehnung gilt in jedem Fall für die Anfrage selbst.

## Beispiel

Ein Agent soll an einen Agenten aus einem anderen Projekt übergeben werden.

1. Du änderst im Projekt „Alpha“ den Übergabe-Agenten eines Agenten (`handoffTo`) und gibst die ID eines Agenten aus dem Projekt „Beta“ an.
2. Die Anfrage wird mit 400 abgelehnt. Die Antwort enthält eine Meldung zum falschen Projekt.
3. Der Agent in „Alpha“ bleibt unverändert, auch sein Übergabe-Agent.

Hinweis: Für `handoffTo` gibt es im Quelltext keine eigene Meldung mit dem Wortlaut „gehört nicht zum Projekt“. Der genaue Text ist deshalb offen (siehe unten).

## Für Entwickler: neues ID-Feld hinzufügen

1. Die Route mit `assertInProject` absichern. Die Prüfung muss vor jedem Schreiben und jeder Folgeaktion stehen.
2. Einen Eintrag in `TENANT_ID_FIELDS` ergänzen (Methode, Pfad, Ort, Feld, Tabelle, Fehlercode).
3. Ein Szenario in `src/api/tenant-ids.test.ts` anlegen.

Fehlt Schritt 2, scheitert der Vollständigkeitstest.

Ausgenommen sind Pfadparameter, die keinen Datensatz bezeichnen (`role` bei Budget-Rollen, `slot` bei Review-Containern). Sie stehen in `TENANT_ID_EXEMPT` mit Begründung.

## Printscreens

Keine. Die Änderung liegt auf der Serverseite. In der Oberfläche ändert sich nichts Sichtbares, und die Ablehnung zeigt sich nur in Antworten der API. Für die Anwendung fehlte in diesem Lauf außerdem ein Browser, und die App war nicht gestartet.

Prüfen lässt sich das Verhalten so:

1. Im Projekt „Alpha“ einen Agenten mit einer ID aus „Beta“ anlegen oder ändern. Die Antwort muss 400 sein, die Liste der Agenten darf sich nicht ändern.
2. Einen Sprint-Vorschlag mit einer fremden Auftrags-ID bestätigen. Auch hier muss die Antwort 400 sein und kein Auftrag darf in den Sprint wechseln.

## Offen

- **Tests nicht ausgeführt.** `npm run typecheck` und der Testlauf (`npm run test:unit` mit `DEV_LOG_TEST_REQUIRE_DATABASE=1`) stehen noch aus. Die Angaben in diesem Kapitel stammen aus dem Quelltext und der Entwickler-Dokumentation `docs/mandanten-pruefung-id-felder-allowlist-2026-10-30.md`.
- **Abdeckung im Code noch nicht vollständig belegt.** Der Vollständigkeitstest soll das zeigen. Bis dahin gilt die Liste in `TENANT_ID_FIELDS` als Absicht, nicht als geprüfter Stand. Die Prüfung in `bugs.ts` (`sprintId`) und die Sprint-Vorschläge (`proposal/apply`, `proposal/comment`) sollen beim Testlauf besonders geprüft werden.
- **Meldungstexte nicht vereinheitlicht.** Der Wortlaut bei der Ablehnung unterscheidet sich je Route. Die Oberfläche zeigt die Meldung nicht zwingend an.
- **Gespeicherte fremde Verweise werden nicht bereinigt.** Eine Prüfung wirkt nur auf neue Anfragen.
- **Query-Parameter sind nicht erfasst.**
