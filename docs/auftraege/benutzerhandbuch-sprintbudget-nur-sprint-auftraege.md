# Benutzerhandbuch: Sprintbudget zählt nur Sprint-Aufträge

Gilt ab Sprint 23 (Auftrag 1ddaeb4b). Betrifft das Sprint-Limit unter Einstellungen → Budget und die Sprint-Aufträge, die wegen dieses Limits blockiert sind.

## Was sich ändert

Bisher zählte das Sprint-Limit den gesamten Projektverbrauch seit Sprintbeginn: Chat, Visionär und Aufträge außerhalb des Sprints. Zudem hatte es kein Ende. Bugfix-Aufträge erbten außerdem den Sprint eines abgeschlossenen Sprints. Sie blieben dadurch dauerhaft mit „Sprintlimit“ blockiert, weil ihr Verbrauch immer weiter wuchs.

Jetzt gilt:

- Das Sprint-Limit zählt nur die Läufe der **Aufträge dieses Sprints**, ab Sprintbeginn.
- **Chat, Auftragsautor und Visionär zählen nicht** zum Sprint-Limit. Sie sind keinem Auftrag zugeordnet. Zum Tages-Limit zählen sie weiter.
- Aufträge außerhalb des Sprints zählen nicht zum Sprint-Limit.
- Das Sprint-Limit gilt **nur für den aktiven Sprint**. Für geplante, abgeschlossene, abgebrochene und Sprints im Review gibt es kein Sprint-Limit mehr.
- Ein Auftrag, der wegen eines Sprint-Limits blockiert war, wird beim nächsten Durchlauf frei, sobald sein Sprint nicht mehr aktiv ist.
- Ein Bugfix-Auftrag übernimmt den Sprint des blockierten Auftrags nur, solange dieser Sprint nicht abgeschlossen oder abgebrochen ist.

Eine neue Oberfläche gibt es dafür nicht. Die Änderung wirkt im Hintergrund. Deshalb gibt es hier keine Printscreens (siehe unten).

## Bedingungen

### Welche Läufe zählen zum Sprint-Limit

| Lauf | Zählt zum Sprint-Limit? | Warum |
|---|---|---|
| Agent-Schritte eines Auftrags, der im **aktiven** Sprint steht, seit Sprintbeginn | Ja | Der Auftrag gehört zum Sprint. |
| Agent-Schritte eines Auftrags außerhalb des Sprints | Nein | Der Auftrag gehört nicht zum Sprint. |
| Chat | Nein | Kein Auftrag zugeordnet. Zählt zum Tages-Limit. |
| Auftragsautor | Nein | Kein Auftrag zugeordnet. Zählt zum Tages-Limit. |
| Visionär | Nein | Kein Auftrag zugeordnet. Zählt zum Tages-Limit. |

Der Sprintbeginn ist das Startdatum des Sprints. Fehlt es, gilt der Zeitpunkt der Anlage.

### Wann ein Sprint-Limit gilt

| Status des Sprints | Sprint-Limit? |
|---|---|
| Aktiv | Ja, falls ein Sprint-Limit gesetzt ist |
| Geplant | Nein |
| Im Review | Nein |
| Abgeschlossen | Nein |
| Abgebrochen | Nein |

Es gibt also **kein Sprintende als Obergrenze**. Das Limit hört auf, weil der Sprint nicht mehr aktiv ist.

### Bugfix-Aufträge

Ein Bugfix erbt den Sprint des blockierten Auftrags nur, solange dieser Sprint nicht abgeschlossen oder abgebrochen ist. Andernfalls gilt:

1. Gibt es einen aktiven Sprint, kommt der Bugfix in diesen Sprint.
2. Gibt es keinen aktiven Sprint, steht der Bugfix ohne Sprint auf `main`.

### Limit einstellen

- Unter **Einstellungen → Budget** lässt sich ein Limit je Zeitraum setzen: Tag, Sprint und Auftrag, jeweils in Tokens und/oder USD.
- Leer = unbegrenzt. Ohne Limit gibt es keine Prüfung.
- Ab 100 % startet kein neuer Agent-Schritt. Ein laufender Schritt endet regulär. Der Auftrag wird dann `blockiert` mit dem Hinweis „Budget erreicht: erhöhen oder warten“.
- Ab 80 % (Standard) kommt eine Push-Warnung. Dieser Wert gilt unverändert.

Tageslimit, Auftragslimit und die Rollenlimits bleiben unverändert.

## Was du siehst

| Situation | Was passiert |
|---|---|
| Sprint ist aktiv, Sprint-Aufträge verbrauchen weniger als das Limit | Die Aufträge laufen weiter. |
| Sprint ist aktiv, Sprint-Aufträge erreichen das Limit | Der nächste Auftrag wird `blockiert` mit „Budget erreicht“. |
| Blockierter Auftrag, dessen Sprint inzwischen abgeschlossen oder abgebrochen ist | Die Sprint-Blockade wird beim nächsten Durchlauf aufgehoben. Der Auftrag wird wieder eingeplant, wenn kein anderes Limit greift. |
| Chat oder Visionär haben viel verbraucht | Das Sprint-Limit ändert sich nicht. Das Tages-Limit kann trotzdem greifen. |

## Beispiel

Ein aktiver Sprint hat ein Sprint-Limit von 100 000 Tokens.

- Der Chat verbraucht seit Sprintbeginn 50 000 Tokens. Das zählt **nicht** zum Sprint-Limit. Der Sprint steht weiterhin bei 0 %.
- Die Aufträge des Sprints verbrauchen 20 000 Tokens. Der Sprint steht bei 20 %.
- Der Sprint wird abgeschlossen. Danach gibt es für diesen Sprint kein Sprint-Limit mehr. Ein dort blockierter Auftrag wird frei.

## Hinweis zur Oberfläche

Die Texte unter **Einstellungen → Budget** sind noch nicht angepasst. Dort steht „Verbrauch = Agent-Schritte und Systemagents (Chat, Auftragsautor, Visionär)“. Das gilt für das Tages-Limit, nicht für das Sprint-Limit. Der Hinweis zum Sprint-Limit lautet noch „Ab Beginn des aktiven Sprints“. Er nennt die Aufträge des Sprints nicht. Die Texte stehen in `frontend/src/app/features/settings/budget-settings.component.html` und `budget-settings.component.ts`.

## Printscreens

Keine. Die Änderung ist ausschließlich serverseitig, und die Oberfläche hat keinen neuen Bedienschritt. In dieser Sitzung lief kein Browser und die Anwendung konnte nicht gestartet werden. Ein Bild würde deshalb dieselbe Einstellungsseite zeigen wie vorher.

Prüfbar ist die Änderung über das Verhalten:

1. Einen Sprint mit Sprint-Limit aktivieren und Aufträge laufen lassen.
2. Im Chat Nachrichten schreiben. Der Sprintverbrauch unter **Einstellungen → Budget** bleibt gleich.
3. Den Sprint abschließen. Blockierte Aufträge dieses Sprints werden beim nächsten Durchlauf frei.

## Offen

- Die Tests wurden in dieser Sitzung nicht ausgeführt. Die Angabe „1622/1622 grün“ stammt vom Entwickler.
- Die Texte unter „Hinweis zur Oberfläche“ sind noch nicht angepasst.
- Wer das Sprint-Limit auch auf Chat, Auftragsautor und Visionär ausdehnen möchte, braucht zuerst eine Auftragszuordnung in `agent_usage`.
