# Benutzerhandbuch: Unterbrochene Aufträge und der Arbeitsordner

Dieses Kapitel beschreibt, was AIdeation mit einem Auftrag macht, der mitten in der Arbeit unterbrochen wird, und wie der nächste Auftrag damit umgeht. Auslöser des Fixes ist der Auftrag b5591912 (25.10.2026).

> **Printscreens:** keine. Die Änderung liegt im Worker (Laufzeit und Git), nicht in der Oberfläche. Der einzige sichtbare Punkt ist der gescheiterte Schritt „Arbeitsordner aufräumen (Git)“ im Lauf; er ist im Code festgelegt, aber nicht in einem laufenden Stand abgebildet. Für Aufnahmen müssten App, Datenbank und Browser laufen; das ist für diesen Auftrag nicht geschehen.

---

## 1. Was vorher passiert ist

Wurde ein Auftrag unterbrochen, setzte AIdeation ihn zurück auf „Geplant“, der Arbeitsordner blieb aber auf dem Branch `auftrag/…` stehen, oft mit offenen Änderungen. Startete danach ein Auftrag ohne Sprint (z. B. ein Bugfix mit Auto-Start), scheiterte er mit der Meldung „Arbeitsordner aufräumen (Git)“, obwohl nichts kaputt war.

## 2. Was jetzt passiert

### 2.1 Bei einer Unterbrechung

Unterbrochen wird ein Lauf z. B. durch Worker-Stopp, Nutzungslimit, Neustart oder einen nicht erreichbaren Projektordner (siehe [`workflows.md`](../workflows.md)). Dann passiert Folgendes:

| Zustand im Arbeitsordner | Was AIdeation tut | Ergebnis |
| --- | --- | --- |
| Offene Änderungen auf `auftrag/…` | Sichert sie als WIP-Commit auf dem Auftrags-Branch und gibt den Ordner frei (zurück auf die Basis). | Der Auftrag ist wieder „Geplant“. Der Ordner ist sauber. |
| Keine offenen Änderungen | Macht **keinen** leeren Commit. | Der Ordner ist sauber. Kein Fehler, kein Schritt. |
| Sichern schlägt fehl (z. B. voller Datenträger) | Ein Schritt „Arbeitsordner aufräumen (Git)“ wird als **gescheitert** angelegt, mit der Git-Meldung. | Der Ordner bleibt auf dem Auftrags-Branch. Der Auftrag ist wieder „Geplant“. |

### 2.2 Beim nächsten Auftrag

- **Sauberer fremder `auftrag/…`-Branch:** Der Auftrag ohne Sprint verlässt ihn und zweigt von `main` ab. Die Arbeit des unterbrochenen Auftrags bleibt als Commit auf dem alten Branch erhalten.
- **Fremde offene Änderungen:** Der Ordner wird **nicht** angefasst. Der Auftrag startet nicht und meldet:
  „Im Arbeitsordner … liegen fremde, nicht committete Änderungen (…) – bitte committen oder verwerfen.“
  Das ist gewollt: Nichts geht verloren.
- **Der unterbrochene Auftrag selbst:** Wenn er wieder dran ist, setzt er auf seinem Branch fort, und sein Zwischenstand ist da.

## 3. Bedingungen

- **Kein Sprint:** Die Regel mit dem Verlassen gilt für Aufträge ohne Sprint. Ein Sprint-Auftrag startet immer vom Sprint-Branch aus; der Ordner wird dafür auf den Sprint-Branch gestellt.
- **Nur sauberer Branch:** Verlassen wird nur ein `auftrag/…`-Branch ohne offene Änderungen. Mit Änderungen bleibt der Ordner, wie er ist.
- **Ein Lauf setzt fort:** Der gescheiterte Aufräum-Schritt ist als „unterbrochen“ markiert. Der nächste Lauf setzt daher beim unterbrochenen Agent fort, statt den Auftrag neu zu schreiben.

## 4. Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| Schritt „Arbeitsordner aufräumen (Git)“ ist gescheitert | Die Meldung nennt die Git-Ursache (z. B. „No space left on device“). Den Ordner von Hand prüfen: offene Änderungen committen oder auf einen eigenen Branch sichern. **Nicht** verwerfen, solange du nicht sicher bist, dass die Änderungen nicht gebraucht werden. Danach läuft der unterbrochene Agent beim nächsten Lauf weiter. |
| „Im Arbeitsordner … liegen fremde, nicht committete Änderungen“ | Der Ordner hat Änderungen, die nicht zu diesem Auftrag gehören (z. B. von dir oder einem Assistenten). Sie committen oder sichern, dann den Auftrag erneut einplanen. |
| Auftrag ohne Fehler, aber Arbeit fehlt im Ordner | Die Arbeit liegt auf dem Branch `auftrag/…` des Auftrags. Dort steht sie als Commit; der Auftrag setzt beim nächsten Start auf diesem Branch fort. |

## 5. Grenzen dieses Kapitels

- Der Testlauf ist im Entwicklerbericht mit `npm test` (1530 von 1530 grün) belegt. Für dieses Kapitel habe ich die Tests nicht selbst gestartet.
- Der Fall „Sprint-Pause“ ist im Auftrag genannt. Ich habe nicht nachgelesen, ob eine Sprint-Pause immer als Unterbrechung im Sinne von 2.1 endet. Wer das wissen muss, sollte es im Lauf beobachten.
- Die Beschreibung sagt nicht, wann genau ein Auftrag erneut startet; das richtet sich nach dem Worker-Durchgang, den dieses Kapitel nicht beschreibt.
- Verweise: Abschnitt „Unterbrechung ist keine Ablehnung“ und die Sicherungsregeln in [`workflows.md`](../workflows.md); die Entwicklerdoku steht in [`unterbrochener-auftrag-verlaesst-auftrags-branch-2026-10-25.md`](unterbrochener-auftrag-verlaesst-auftrags-branch-2026-10-25.md).
