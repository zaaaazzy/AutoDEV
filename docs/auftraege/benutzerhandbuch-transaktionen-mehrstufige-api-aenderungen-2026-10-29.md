# Benutzerhandbuch: Mehrstufige Änderungen und doppelte Aufträge

Dieses Kapitel beschreibt, was du beim Übernehmen einer Idee, beim Löschen eines Auftrags, beim Löschen eines Projekts, beim Löschen einer Kategorie und beim Anlegen oder Ändern eines Benutzers siehst. Die Änderung sorgt dafür, dass mehrstufige Vorgänge entweder ganz oder gar nicht ausgeführt werden. Neu ist außerdem, dass zu einer Idee höchstens ein Auftrag existiert.

## 1. Was neu ist

- **Ein Auftrag je Idee.** Zu einer Idee gibt es höchstens einen Auftrag. Ein Doppelklick auf „Auftrag erstellen“ (bei Ideen des Visionärs: „Übernehmen“) legt keinen zweiten Auftrag an.
- **Entweder ganz oder gar nicht.** Schlägt ein Vorgang mitten im Ablauf fehl, bleibt kein Teilzustand zurück. Beispiel: Die Idee steht nicht mehr auf „angenommen“, obwohl kein Auftrag existiert.
- **Löschen öffnet die Idee wieder.** Wird der letzte Auftrag einer Idee gelöscht, steht die Idee danach wieder offen.
- **Klare Meldung statt halber Änderung.** Kollidiert ein Vorgang mit einem bereits bestehenden Stand, kommt eine Meldung, und es wird nichts geändert.

## 2. Ideen zu Aufträgen machen

Eine Idee wird über „Auftrag erstellen“ (Visionär: „Übernehmen“) zum Auftrag. Der Auftragsautor formuliert daraus einen Auftrag im Backlog.

**Bedingungen:**

- Der Knopf erscheint nur, wenn die Idee noch keinen Auftrag hat und in einem auswählbaren Status steht. Hat sie schon einen Auftrag, erscheint er nicht.
- Zu dem Knopf gehört das Recht „Planen“.
- Ein zweiter Klick, während die Idee schon angefordert ist, wird abgewiesen mit: „Die Idee ist nicht mehr in Bearbeitung durch Menschen.“
- Hat die Idee schon einen Auftrag, wenn der Auftragsautor fertig wird, legt er keinen zweiten an. Die Idee wird als „angenommen“ markiert. Der bestehende Auftrag bleibt unverändert, es erscheint kein Fehler.
- Ist der bestehende Auftrag schon in Arbeit oder erledigt, wird er nicht überschrieben. Die Idee wird ebenfalls „angenommen“.

## 3. Einen Auftrag löschen

Ein Auftrag wird endgültig gelöscht, Läufe und Abnahme werden mit gelöscht.

**Bedingungen:**

- Ein Auftrag, an dem gerade ein Agent arbeitet, lässt sich nicht löschen. Die Meldung lautet: „Der Auftrag läuft gerade und kann nicht gelöscht werden.“
- Gibt es zur Idee danach keinen weiteren Auftrag, ist die Idee wieder offen und kann erneut zum Auftrag gemacht werden.
- Gibt es noch einen anderen Auftrag zur Idee, bleibt die Idee „angenommen“.
- Löschen und Wiederöffnen der Idee laufen zusammen. Scheitert eins, passiert auch das andere nicht.

## 4. Ein Projekt löschen

- Wenn du „Ordner löschen“ ankreuzt, wird der Auftrag zum Entfernen des Projektordners nur zusammen mit dem Projekt angelegt.
- Scheitert das Löschen des Projekts, bleibt der Ordner erhalten, und es entsteht kein Auftrag zum Entfernen.
- Solange ein Agent am Projekt arbeitet, lässt sich das Projekt nicht löschen. Die Meldung lautet: „Gerade arbeitet ein Agent am Projekt – bitte warten oder abbrechen.“

## 5. Eine Kategorie löschen

- Beim Löschen einer Kategorie werden ihre Befehle aus den Agents entfernt und die Projektliste bereinigt. Das geschieht in einem Schritt.
- Scheitert einer dieser Schritte, bleibt alles wie vorher. Agents behalten dann ihre Befehle, und die Kategorie bleibt bestehen.

## 6. Benutzer anlegen und ändern

- **Anlegen:** Benutzer und Projektzugriff werden zusammen angelegt. Ein Konto ohne Projektzugriff entsteht bei einem Fehler nicht.
- **Benutzername doppelt:** Gibt es den Benutzernamen schon, lautet die Meldung: „Diesen Benutzernamen gibt es schon.“ Es wird nichts angelegt.
- **Ändern:** Rollen, Projektzugriff und Abmelden werden zusammen gespeichert.
- **Deaktivieren:** Ein deaktivierter Benutzer wird sofort abgemeldet. Seine offenen Sitzungen enden.
- **Eigene Administration:** Du kannst dir die Administration nicht selbst entziehen. Diese Regel bleibt wie bisher.

## 7. Was du tust

| Du siehst | Ursache | Was du tust |
|---|---|---|
| „Die Idee ist nicht mehr in Bearbeitung durch Menschen.“ | Ein zweiter Klick oder ein anderer Nutzer hat die Idee schon angefordert. | Nichts. Der Auftrag entsteht über den Auftragsautor. Auf der Idee den Stand prüfen. |
| „Der Auftrag läuft gerade und kann nicht gelöscht werden.“ | Ein Agent arbeitet am Auftrag. | Warten, bis der Lauf endet, oder den Lauf abbrechen. Danach erneut löschen. |
| „Diesen Benutzernamen gibt es schon.“ | Der Name ist vergeben. | Einen anderen Benutzernamen wählen. |
| Idee steht auf „angenommen“, aber der Auftrag fehlt | Vor dieser Änderung konnte ein Fehler zwischen den Schritten einen Teilzustand hinterlassen. | Den Vorgang wiederholen. Mit der Änderung kann das nicht mehr passieren. Bei älteren Daten den Admin informieren. |

## 8. Bedingungen und Ausnahmen

- Die Regel „ein Auftrag je Idee“ gilt für Aufträge, die einer Idee zugeordnet sind. Aufträge ohne Idee sind davon nicht betroffen.
- Vor dem Einspielen der Änderung gab es bei manchen Ideen schon doppelte Aufträge. Bei diesen Altdaten behält der **älteste** Auftrag den Verweis auf die Idee. Die übrigen verlieren nur ihren Verweis auf die Idee. **Gelöscht wird nichts.** Auftrag, Verlauf und Arbeit bleiben erhalten.
- Diese Änderung betrifft nur die oben genannten Vorgänge. Andere mehrstufige Änderungen sind hier nicht geprüft.
- Die Meldungen „monthly spend limit“ im Bug-Verlauf sind Abbrüche durch das Ausgabenlimit der Claude-CLI. Sie sind kein Fehler dieser Änderung. Die betroffenen Aufträge müssen nach dem Zurücksetzen des Limits neu angestoßen werden.

## 9. Printscreens

Für dieses Kapitel fehlen noch die Aufnahmen. Die App mit Datenbank und Browser konnte in dieser Umgebung nicht gestartet werden, deshalb gibt es keine Bilder. Nötig wären:

1. Idee-Detail mit dem Knopf „Auftrag erstellen“ und, bei Visionär-Ideen, „Übernehmen“.
2. Idee-Detail mit dem Hinweis „Auftrag erstellen“ nach einem Doppelklick (Meldung „Die Idee ist nicht mehr in Bearbeitung durch Menschen.“).
3. Auftrag-Löschen-Dialog mit der Meldung „Der Auftrag läuft gerade …“.
4. Benutzer-Formular mit der Meldung „Diesen Benutzernamen gibt es schon.“.

## 10. Nicht geprüft

- Die Datenbank-Tests in `src/db/transaction.test.ts` brauchen PostgreSQL und wurden in diesem Lauf nicht ausgeführt. Die Zahlen stammen vom Entwickler.
- Die Anzeige der Meldungen in der Oberfläche ist nicht geprüft. Der Doppelklick ist nicht von Hand getestet.
- Die Route `POST /ideation/:id/promote` wird von der Oberfläche nicht aufgerufen. Die Oberfläche nutzt `/ideation/:id/define`. Der Schutz vor doppelten Aufträgen greift dort über den Auftragsautor und den Unique-Index.
- Das Formular „Entwicklungsauftrag hinzufügen“ sendet keine Idee. Die 409-Antwort „Zu dieser Idee gibt es schon einen Auftrag.“ ist deshalb über die Oberfläche nicht erreichbar. Sie gilt nur für direkte API-Aufrufe.
- Ob weitere Routen Transaktionen brauchen, ist nicht geprüft.
