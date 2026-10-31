# Benutzerhandbuch: Workflow während eines Laufs ändern

Dieses Kapitel beschreibt, was passiert, wenn du den Workflow unter „Agents“ umbaust, während ein Auftrag gerade läuft. Auslöser des Fixes ist der Bugfix c6952ea1 (25.10.2026): Ein Umbau löschte einen Schritt, den der laufende Auftrag noch brauchte, und der Auftrag stand danach ohne Begründung auf „blockiert“.

> **Printscreens:** keine. In dieser Sitzung gab es keinen Browser und keine laufende App, daher sind keine Aufnahmen entstanden. Die Beschreibung stammt aus dem Quelltext (`src/runner/runner-steps.ts`, `src/runner/runner.ts`) und aus [`workflows.md`](../workflows.md), Abschnitt 4a. Für Aufnahmen müssten App, Datenbank und Browser laufen.

---

## 1. Was vorher passiert ist

Der Runner lädt den Workflow einmal je Zyklus. Löschtest du während eines Laufs einen Einsatz oder Agenten, hielt der Lauf noch die alten Schritte. Beim nächsten Schritt schrieb er einen Verweis auf den gelöschten Schritt. Die Datenbank wies das ab, der Lauf endete mit „aborted“, und der Auftrag stand auf „blockiert“ mit leerem Feld „Begründung“. Der Fehler stand nur im Worker-Log.

## 2. Was jetzt passiert

### 2.1 Du baust den Workflow um, während ein Auftrag läuft

| Was du tust | Was mit dem laufenden Auftrag passiert |
| --- | --- |
| Einen Einsatz „Entfernen“ oder „Pausieren“ | Der laufende Auftrag arbeitet den Lauf mit den Schritten zu Ende, die beim Start galten. Der gelöschte Schritt wird nicht mehr referenziert. |
| Einen Agenten aus dem Workflow nehmen | Der bereits gestartete Schritt bleibt im Verlauf mit Name und Phase sichtbar. Der Verweis auf den Agenten fehlt dann (leer). |
| Einen Schritt neu anordnen (↑↓ oder per Ziehen am Griff ⠿), in eine andere Phase verschieben (Ziehen oder Auswahl „In Phase verschieben“) oder einen Agenten hinzufügen | Der laufende Auftrag nutzt bis zum Ende den alten Ablauf. Erst der nächste Lauf nutzt den neuen. |

Das Ergebnis des Auftrags hängt nicht davon ab, ob du einen Schritt gelöscht hast. Ein erfolgreicher Lauf bleibt erfolgreich.

### 2.2 Ein Lauf bricht trotzdem unerwartet ab

Tritt aus einem anderen Grund ein unerwarteter Fehler im Lauf auf, passiert Folgendes:

- Der Auftrag wird **blockiert**.
- Am Auftrag steht die Begründung **„Lauf abgebrochen: …“** mit der Fehlermeldung dahinter.

„Blockiert“ ohne Begründung gibt es damit nicht mehr. Die Begründung steht im Auftrag, nicht nur im Worker-Log.

## 3. Bedingungen

- **Schritt ohne Verweis:** Ist ein Schritt oder Agent beim Schreiben des Laufs schon gelöscht, speichert der Lauf `NULL` als Verweis. Name und Phase bleiben erhalten. Der Lauf geht weiter.
- **Alter Ablauf bis zum Ende:** Ein laufender Auftrag bleibt beim Workflow seines Starts. Nur der nächste Lauf übernimmt Änderungen.
- **Auswertungen:** Schritte mit leerem Verweis sind möglich. Auswertungen über die Lauftabelle müssen deshalb mit `LEFT JOIN` arbeiten und Name und Phase aus dem Schritt selbst lesen.
- **Unterbrechung ist keine Blockade:** Die Fälle „Worker wird beendet“, „Arbeitsordner nicht sauber“ und „Projektordner kurz weg“ führen nicht zu „Lauf abgebrochen: …“. Der Auftrag wird dann wieder eingeplant (siehe [`benutzerhandbuch-unterbrochene-auftraege.md`](benutzerhandbuch-unterbrochene-auftraege.md)).

## 4. Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| Auftrag „blockiert“ mit „Lauf abgebrochen: …“ | Die Meldung nennt die Ursache. Sie beheben, dann den Auftrag erneut einplanen. |
| Im Verlauf fehlt bei einem Schritt der Agent oder Einsatz | Erwartet, wenn der Agent oder Einsatz gelöscht wurde. Name und Phase des Schritts bleiben sichtbar. |
| Ein Umbau wirkt bei einem laufenden Auftrag nicht | Erwartet. Der laufende Lauf nutzt den alten Ablauf. Der nächste Lauf nutzt den neuen. |
| Auftrag ist „blockiert“ ohne Begründung | Sollte nicht mehr auftreten. Bitte den Auftrag mit Datum und Uhrzeit melden. |

## 5. Grenzen dieses Kapitels

- Die Tests für diese Änderung stehen in `src/runner/runner.test.ts` („Workflow während des Laufs umgebaut…“ und „unerwarteter Fehler im Lauf…“). Ich habe sie in dieser Sitzung nicht selbst ausgeführt. Der Entwickler meldet alle Tests grün über `npm test`.
- Das Kapitel beschreibt nicht, wie der Workflow-Editor bedient wird. Das steht in [`workflows.md`](../workflows.md), Abschnitt 4a.
- Ob der Verlauf den Schrittnamen auch nach einem Umbau zeigt, ist im Code nicht ausdrücklich geprüft. Die Spalten `agent_name` und `phase` werden beim Schreiben gesetzt und nicht nachträglich gelesen.

## 6. Verweise

- [`workflows.md`](../workflows.md), Abschnitt 4a „Workflow“ (Editor und Umbau während eines Laufs)
- [`benutzerhandbuch-unterbrochene-auftraege.md`](benutzerhandbuch-unterbrochene-auftraege.md) (Unterbrechungen und Arbeitsordner)
- [`workflow-umbau-waehrend-lauf-fk-2026-10-25.md`](workflow-umbau-waehrend-lauf-fk-2026-10-25.md) (Entwicklerdoku zum Fix)
