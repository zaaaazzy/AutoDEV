# Benutzerhandbuch: Nachrichten an einen festen Agent und Review-Container

Dieses Kapitel beschreibt zwei Stellen, an denen AIdeation seit dem Auftrag d7054b90 (25.10.2026) nur noch Agents und Aufträge **desselben Projekts** annimmt: den festen Empfänger einer Agent-Nachricht („Nachricht geht an“) und den Start eines Review-Containers für einen Auftrag.

> **Printscreens:** keine. Für Aufnahmen müssten App, Datenbank und Browser laufen; das ist für diesen Auftrag nicht geschehen. Die Beschreibung nennt, was die Antwort der Schnittstelle sagt. Die Beschriftungen in der Oberfläche sind nicht gegen einen laufenden Stand geprüft.

---

## 1. Fester Empfänger einer Agent-Nachricht („Nachricht geht an“)

Ein Agent kann Nachrichten an einen anderen Agent weitergeben. Schreibt der Agent `@@NACHRICHT: …` ohne Namen, geht die Nachricht an den **festen Empfänger** (Feld „Nachricht geht an“ am Agent), sofern einer gesetzt ist. Ist keiner gesetzt, geht sie an den nächsten Agent im Ablauf.

### 1.1 Was sich geändert hat

- Als Empfänger lässt sich nur ein Agent **desselben Projekts** speichern.
- Ein Agent aus einem anderen Projekt wird abgelehnt. Die Antwort lautet **400** mit der Meldung „Der Empfänger gehört nicht zu diesem Projekt.“ Dabei wird nichts gespeichert.
- Gilt für Administratoren und für Benutzer mit der Rolle „Agents verwalten“ gleichermaßen.
- „Kein fester Empfänger“ (`null`) bleibt erlaubt und hebt die Zuordnung auf.

### 1.2 Bedienung

| Aktion | Wo | Ergebnis |
| --- | --- | --- |
| Empfänger setzen | Agent bearbeiten → „Nachricht geht an“ | Der Empfänger wird gespeichert, wenn er zum selben Projekt gehört. |
| Empfänger aufheben | Agent bearbeiten → „Nachricht geht an“ auf „keiner“ | Die Nachricht ohne Namen geht an den nächsten Agent im Ablauf. |
| Fremden Agent wählen | nur über die Schnittstelle möglich | 400, nichts wird gespeichert. |

### 1.3 Bedingungen und Grenzen

- **Nur beim Bearbeiten.** Die Schnittstelle nimmt den Empfänger beim Anlegen eines Agents nicht entgegen. Setze ihn nach dem Speichern des Agents.
- **Alte Zuordnungen bleiben stehen, werden aber nicht genutzt.** Hatte ein Agent schon vor dieser Änderung einen Empfänger aus einem anderen Projekt, wird er nicht gelöscht. Beim Lauf sucht AIdeation den Empfänger nur unter den Agents des eigenen Ablaufs. Der fremde Empfänger wird dort nicht gefunden, und die Nachricht geht an den nächsten Agent. Eine Bereinigung ist nicht nötig. Wer die Zuordnung sauber haben will, setzt sie einmal auf „keiner“ und wieder auf den richtigen Agent.
- **Nachrichten mit Namen** (`@@NACHRICHT an <Name>: …`) folgen derselben Regel: Empfänger ist nur ein Agent des eigenen Projekts.
- Den Empfänger siehst du beim Empfänger unter „Nachrichten an dich“. Die Nachrichten stehen außerdem im Verlauf des Schritts.

### 1.4 Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| Speichern des Agents endet mit „Der Empfänger gehört nicht zu diesem Projekt.“ | Der gewählte Agent gehört zu einem anderen Projekt oder existiert nicht. Einen Agent aus dem aktiven Projekt wählen oder „keiner“. |
| Nach dem Anlegen fehlt die Zuordnung | Beim Anlegen wird sie nicht gespeichert. Den Agent danach bearbeiten und den Empfänger setzen. |
| Nachricht ist beim erwarteten Agent nicht angekommen | Prüfe, ob der feste Empfänger im selben Projekt liegt. Eine alte fremde Zuordnung wird übergangen; die Nachricht geht an den nächsten Agent im Ablauf. |

---

## 2. Review-Container für einen Auftrag starten

In der Sprint-Ansicht lässt sich ein Stand (Commit) des Projekts in einem Review-Container starten. Ein Auftrag kann dabei angegeben werden, damit der Container dessen Stand zeigt und wiederverwendet werden kann.

### 2.1 Was sich nicht geändert hat, und was jetzt sicher ist

- Die Auftrags-ID wird gegen das **Projekt der Anfrage** geprüft. Ein Auftrag aus einem anderen Projekt wird **nicht** übernommen. Er ergibt **404** mit „Auftrag nicht gefunden.“, und es wird kein Container belegt.
- Die Meldung ist 404, nicht 400, wie der Auftrag es vorsah. Der Projektbezug war für diesen Start schon geprüft; geändert wurde dort nichts.
- Der Stand muss ein vollständiger Commit sein (40 Zeichen, Hex). Sonst kommt „Bitte einen Stand (Commit) wählen.“ mit 400.
- Eine ungültige Umgebung ergibt 400 „Ungültige Umgebung.“.

### 2.2 Welcher Container gewählt wird

- Ist eine Umgebung angegeben, wird genau diese gewählt, sofern sie frei gegeben ist.
- Ohne Angabe sucht AIdeation einen passenden Container. Dabei bevorzugt es einen Container, der schon zu **diesem** Auftrag gehört, dann einen freien manuellen Container des Projekts, dann einen leeren.

### 2.3 Bedingungen und Grenzen

- **Rechte:** Der Start verlangt die Rolle „Ausführen“.
- **Administrator sperrt einen Container:** Ein Administrator kann einen Container sperren. Ein gesperrter Container wird vom Worker beendet.
- **Freigabe-Schritt:** Ob die Freigabe eines Auftrags den Container ebenfalls nur über den Projektbezug wählt, ist für diesen Auftrag nicht im Code nachgelesen worden und bleibt offen.
- **Administratoren:** Für Projekte mit eigener Datenbank schlägt der Review-Slot derzeit fehl (siehe [`benutzerhandbuch-dashboard-agents.md`](benutzerhandbuch-dashboard-agents.md), Abschnitt 3).

### 2.4 Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| „Auftrag nicht gefunden.“ (404) beim Start | Der Auftrag gehört nicht zum aktiven Projekt. Den Start aus der Sprint-Ansicht des richtigen Projekts anstoßen. |
| „Bitte einen Stand (Commit) wählen.“ (400) | Es wurde kein vollständiger Commit übergeben. Einen Stand aus der Liste wählen. |
| „Dieser Review-Container läuft nicht.“ (409) beim Beenden | Der Container läuft gerade nicht. Die Liste neu laden. |

---

## 3. Grenzen dieses Kapitels

- Die Prüfung der Empfänger-Zuordnung wurde im Code nachgelesen. Der Testlauf dafür ist noch offen: `npx --no-install tsx --test src/api/agents.test.ts src/api/agent-tasks.test.ts`. Solange der Lauf nicht grün ist, gilt das Verhalten als **nicht bestätigt**.
- Ob der Freigabe-Schritt im Review-Container den Projektbezug schon prüft, ist im Code nicht gelesen worden.
- Die Beschriftungen der Felder („Nachricht geht an“, „Ausführen“, „Planung“) stammen aus dem Code bzw. dem bestehenden Handbuch und sind nicht im Browser gegengeprüft.
