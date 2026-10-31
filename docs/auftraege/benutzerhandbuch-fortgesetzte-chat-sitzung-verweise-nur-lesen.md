# Benutzerhandbuch: Antwort auf eine Rückfrage im Chat mit Verweisen

Dieses Kapitel beschreibt, wie der Chat-Agent eine Antwort auf seine Rückfrage behandelt, wenn du darin Verweise wie `/auftrag/<id>` anhängst. Auslöser ist der Auftrag 30efcc05 (Bugfix, Schwere niedrig, Gesamtprüfung vom 21.10.2026).

> **Printscreens:** keine. Die Änderung betrifft nur den internen Text (Prompt), den der Agent beim Fortsetzen erhält. In der Oberfläche ändert sich nichts: keine neuen Knöpfe, Felder oder Meldungen. Für Aufnahmen hätte ich App, Datenbank und Browser starten müssen; das ist in diesem Lauf nicht geschehen.

---

## 1. Was vorher passiert ist

Stellt der Chat-Agent eine Rückfrage und du antwortest, setzt AIdeation die Sitzung mit dem Agenten fort. Dabei ging nur deine Antwort an den Agenten. Zwei Dinge fehlten:

- **Die Verweise.** Hast du `/auftrag/<id>`, `/bug/<id>` oder `/doc/…` angehängt, sah der Agent den Inhalt nicht. Er antwortete ohne den verlinkten Kontext.
- **Der Nur-lesen-Hinweis.** Lief gerade ein Auftrag im Projektordner, wusste der Agent das nicht. Er versuchte Dateien zu ändern und wurde abgewiesen.

## 2. Was jetzt passiert

Beim Fortsetzen erhält der Agent die Antwort zusammen mit den Verweisen und, falls nötig, mit dem Nur-lesen-Hinweis. Die Reihenfolge im Prompt ist:

1. deine Antwort auf die Rückfrage,
2. der Abschnitt „Verweise des Nutzers (beziehe dich darauf)“ mit dem Inhalt der Verweise,
3. die Aufforderung, damit weiterzuarbeiten, samt Regel für weitere Rückfragen,
4. der Nur-lesen-Hinweis, wenn der Ordner belegt ist.

Die Projektregeln stehen wie bisher vor dem Prompt. Ein Prompt ohne Rückfrage bleibt unverändert.

## 3. Bedingungen

| Situation | Was der Agent erhält |
| --- | --- |
| Antwort auf eine Rückfrage, ohne Verweis, Ordner frei | Nur deine Antwort und die Aufforderung. Kein Verweisabschnitt, kein Hinweis. |
| Antwort auf eine Rückfrage, mit Verweis | Zusätzlich der Abschnitt „Verweise des Nutzers“. |
| Antwort auf eine Rückfrage, Ordner belegt (z. B. ein Auftrag läuft) | Zusätzlich der Nur-lesen-Hinweis. Der Agent darf dann keine Dateien ändern und keine Befehle ausführen. Er beschreibt Änderungen als Vorschlag. |
| Verweis und belegter Ordner zugleich | Beides. |

Weitere Bedingungen:

- **Verweistypen:** Auftrag, Idee, Bug, Sprint, Dokument, Git-Commit und Person. Höchstens 5 Verweise je Nachricht.
- **Nur Verweise im Projekt:** Ein Verweis wird nur aufgelöst, wenn das Objekt zum selben Projekt gehört. Ein Verweis, der nicht aufgelöst werden kann, fehlt im Abschnitt, ohne dass die Antwort scheitert.
- **Ordner belegt:** Der Ordner gilt als belegt, wenn ein Auftrag, ein Testlauf oder ein anderer Worker ihn gerade benutzt. Dann läuft der Chat nur lesend. Ist er frei, nimmt der Chat ihn für die Dauer der Antwort und gibt ihn danach wieder frei.
- **Fremdtext:** Stammt ein Verweis aus einem Betriebs- oder GitHub-Bug, steht sein Inhalt eingerahmt, und der Agent erhält einen Sicherheitshinweis. Der Inhalt wird nicht als Anweisung behandelt.
- **Länge:** Der Text je Verweis wird auf 2500 Zeichen gekürzt.

## 4. Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| Der Agent antwortet, als kenne er den Auftrag nicht, obwohl du `/auftrag/<id>` angehängt hast | Mit dem Fix sollte das nicht mehr vorkommen. Prüfe, ob die ID zum aktuellen Projekt gehört. Ein fremder Verweis fehlt im Abschnitt. |
| Der Agent meldet, er dürfe nicht ändern | Ein Auftrag läuft im Projektordner. Das ist gewollt. Warte, bis der Lauf endet, oder beschreibe die Änderung und lass sie danach als Auftrag laufen. |

## 5. Grenzen dieses Kapitels

- Der Fix ändert nur den Text, den der Agent erhält. Ob der Agent die Verweise dann richtig nutzt, hängt von seiner Antwort ab; das kann dieses Kapitel nicht garantieren.
- Laut Entwickler laufen 1625 von 1625 Unit-Tests grün. Drei Regressionstests in `src/agent/chat.test.ts` prüfen den Befehl, den der Agent erhält. Ich habe die Tests in diesem Lauf nicht selbst ausgeführt.
- Die Änderung ist noch nicht in `main` gemerged.
- Für Entwickler: Die Umsetzung steht in [`fortgesetzte-chat-sitzung-verweise-nur-lesen-2026-10-28.md`](fortgesetzte-chat-sitzung-verweise-nur-lesen-2026-10-28.md).
