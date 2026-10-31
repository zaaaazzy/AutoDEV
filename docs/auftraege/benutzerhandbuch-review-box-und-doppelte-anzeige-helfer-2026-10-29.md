# Benutzerhandbuch: Review-Boxen und Anzeige-Helfer

Stand: 2026-10-29 · Auftrag `5a2d353b` · Sprint 28

## Was sich für dich ändert

Die Oberfläche ändert sich kaum. Der Auftrag hat die Freigabe-Box und die Abnahme-Box so zusammengeführt, dass beide
dieselben Regeln verwenden. Vorher waren es zwei Kopien, die auseinanderlaufen konnten. Die Bedingungen unten sind
die, die jetzt für beide gelten.

- **Gleiche Statuszeile in beiden Boxen** (Freigabe unter Auftragsdetail und „Rückmeldungen der Agents“, Abnahme
  unter „Aktionen“).
- **Gleiche Regeln für Container und Start-Knopf** (siehe Tabelle unten). Der Abnahme-Start braucht zusätzlich das
  Recht „Agents starten“.
- **Keine neuen Funktionen.** Sprint-Kennzahlen, CI-Ampel, Titel und Git-Graph zeigen wie vorher dieselben Werte. Die
  Berechnung läuft nur noch einmal, nicht bei jeder Anzeige neu.

Die Bedingungen sind aus dem Code gelesen. **Die Oberfläche wurde nicht im Browser geprüft.** Printscreens fehlen
deshalb, siehe Abschnitt „Printscreens“.

## Wo du die Review-Boxen findest

**Freigabe-Box** (`app-order-approval`):
- Im Auftragsdetail, wenn der Auftrag den Status „Freigabe“ hat. Dort stehen auch die Knöpfe „✓ Freigeben“ und
  „↩ Zurückweisen“.
- Unter „Aktionen“ → „Rückmeldungen der Agents“, wenn der Auftrag auf deine Freigabe wartet. Dort fehlen die Knöpfe
  Freigeben und Zurückweisen; sie stehen in der Aktionszeile des Auftrags.

**Abnahme-Box** (`app-acceptance-review`):
- Unter „Aktionen“ → „Rückmeldungen der Agents“, bei Aufträgen mit Abnahmepunkten zum Abhaken.
- Nur, wenn der Auftrag weder im Status „Freigabe“ noch „In Arbeit“ ist.

## Bedingungen

| Anzeige | Wann sie erscheint |
|---|---|
| Statuszeile mit Punkt | Es gibt einen Review-Container für **genau diesen** Auftrag, der nicht frei ist. Freie Container und Container anderer Aufträge zählen nicht. |
| Link „Review N öffnen ↗“ | Nur, wenn der Container läuft (Status „läuft“). Der Link öffnet den Container in einem neuen Tab. |
| Log in grauer Box | Nur bei gescheitertem Start, wenn eine Meldung vorliegt. |
| Hinweis „Kein Review-Befehl eingestellt – unter Einstellungen → Review-Freigabe ergänzen.“ (Freigabe-Box) bzw. „Zum Ausprobieren fehlt der Review-Befehl – unter Einstellungen → Review-Freigabe ergänzen.“ (Abnahme-Box) | Wenn unter Einstellungen → Review-Freigabe kein Review-Befehl eingetragen ist. Die Abnahme-Box zeigt dann nur diesen Hinweis. Die Freigabe-Box zeigt ihn zusätzlich. |
| Start-Knopf | Freigabe-Box: nur, wenn der Review-Befehl eingestellt ist **und** kein Container für den Auftrag läuft oder gestartet ist. Ein gescheiterter Start zählt als „nicht gestartet“. Abnahme-Box: wie Freigabe-Box, zusätzlich nur mit dem Recht „Agents starten“. |
| Hinweis „Alle Review-Container sind belegt“ | Freigabe-Box, wenn kein Container frei ist und der Auftrag keinen eigenen hat. Der Knopf „Im Review-Container anzeigen“ bleibt dann sichtbar und übernimmt einen Container. |
| Hinweis „Wird gleich in einem freien Review-Container gestartet …“ | Freigabe-Box, wenn ein Container frei ist, aber noch keiner für den Auftrag angezeigt wird. |

Die Freigabe-Box startet einen Container über den Knopf **„👀 Im Review-Container anzeigen“**. Die Abnahme-Box
verwendet **„🖥 Im Review-Container prüfen“**. Ist schon ein Container für den Auftrag gescheitert, heißt der
Knopf in beiden Boxen **„↻ Review-Container neu starten“**.

Nach dem Start lädt die Box den Stand nach. Das passiert nur, wenn du inzwischen nicht das Projekt gewechselt hast.
Ein Poll aktualisiert die Boxen alle 5 Sekunden, solange eine Box offen ist. Im Hintergrundtab läuft er nicht.

## Statuszeile je Status

| Status des Containers | Angezeigter Text |
|---|---|
| `running` | „Review N läuft“ (mit Link „Review N öffnen ↗“) |
| `starting` | „Review N startet (Abhängigkeiten, Datenbank-Kopie) …“ |
| `failed` | „Review N konnte nicht starten“ und darunter das Log |
| `requested`, `stopping` und alle anderen | „Wird gestartet …“ |

Läuft der Container und ist ein Testlauf aktiv, zeigt die Zeile nur „Review N“. Der Balken des Testlaufs steht darunter.

**Hinweis:** Bei `stopping` (Container wird beendet) steht „Wird gestartet …“. Das ist falsch, aber schon vor diesem
Auftrag so gewesen. Siehe „Offene Punkte“.

## Sprint-Seite und Liste

- **CI-Ampel:** Text „grün“ (Erfolg), „rot“ (Fehler), „läuft“ (ausstehend), „unbekannt“ (sonst). Der Text steht im
  Sprint-Detail neben „Pull Request #N“ und im Tooltip der Sprint-Liste. Die Logik liegt jetzt an einer Stelle.
- **Auftragszähler** („n / m Aufträge erledigt“), **Geschätzt**, **Tokens**, **Kosten** und **Aufgewendet** zeigen wie
  vorher die Werte des Sprints. Aufgewendet zeigt „–“, wenn kein Agent-Schritt Dauer hat.

## Titel ohne „Bug:“

In der Auftragsliste und unter „Aufträge“ im Sprint zeigt die Oberfläche bei Aufträgen der Art „Bug“ den Titel
ohne das Präfix „Bug:“. Groß- und Kleinschreibung spielen keine Rolle. Bei anderen Arten bleibt der Titel unverändert.
Der gespeicherte Titel ändert sich nicht.

## Printscreens

**Keine.** Die App mit Datenbank und Browser ist für diesen Auftrag nicht gestartet worden. Diese Liste zeigt, was
nach einer Browser-Prüfung fotografiert werden soll:

1. Freigabe-Box im Auftragsdetail mit laufendem Container (Punkt, Link „Review N öffnen ↗“).
2. Freigabe-Box ohne Container mit Knopf „👀 Im Review-Container anzeigen“.
3. Abnahme-Box unter „Aktionen“ mit gescheitertem Container und Log.
4. Sprint-Detail mit CI-Ampel neben dem Pull Request.

Vorschlag für die Dateien: `docs/bilder/review-box-1.png` bis `review-box-4.png`. Die Dateien gibt es noch nicht.

## Offene Punkte

| Stand | Punkt | Hinweis |
|---|---|---|
| offen | Statuszeile bei `stopping` | Zeigt „Wird gestartet …“ statt eines Textes zum Beenden. War schon vorher so. |
| offen | Recht beim Freigabe-Start | Die Freigabe-Box prüft das Recht „Agents starten“ im Template nicht; die Abnahme-Box schon. Ob der Server den Start trotzdem ablehnt, ist hier nicht geprüft. |
| offen | Browser-Prüfung | Bedienung und Texte sind aus dem Code gelesen, nicht im Browser gesehen. |
| offen | Tests | Die Tests (`npm run test:unit`) sind in diesem Lauf nicht erneut ausgeführt. Die CI ist laut Bug-Liste ohnehin offen. |
| offen | Printscreens | Erst nach der Browser-Prüfung. |

Zum Zurücksetzen des Abnahme-Häkchens nach einem Fehler: siehe
`docs/benutzerhandbuch-abnahme-haekchen-nach-fehler-zuruecksetzen-2026-10-29.md`. Dieser Teil wurde nicht geändert.
