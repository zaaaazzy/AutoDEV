# Benutzerhandbuch: Wiederholungszähler zurücksetzen und Wiederholung mit Pause

Gilt ab Sprint 23 (Auftrag 9894c0ef, Bugfix). Betrifft Aufträge mit Merge-Konflikten, den Knopf „Erneut versuchen“ und die Phase „Vor dem Sprint“.

## Was sich ändert

Zwei Zähler haben sich falsch verhalten:

- **Merge-Konflikte:** Der Zähler für automatische Neuversuche wurde nie zurückgesetzt, auch nicht, wenn du einen Auftrag von Hand erneut gestartet hast. Nach zwei Konflikten führte jeder weitere Konflikt sofort zu „Blockiert“.
- **Phase „Vor dem Sprint“:** Die Fehlversuche wurden nur im Speicher des Workers gezählt. Die drei Versuche liefen ohne Pause hintereinander, etwa alle 30 Sekunden. Ein Ausfall von zwei Minuten (z. B. Ollama nicht erreichbar) verbrauchte alle drei.

Jetzt gilt:

- Der Konflikt-Zähler wird beim Erfolg und beim Wiederaufnehmen zurückgesetzt. Du bekommst nach einem manuellen Neustart wieder die vollen automatischen Neuversuche.
- Die Versuche von „Vor dem Sprint“ und der nächste Zeitpunkt werden am Sprint gespeichert. Sie überstehen einen Neustart des Workers.
- Zwischen den Versuchen wartet der Sprint mit wachsender Pause.

Eine neue Bedienung gibt es nicht. Die Änderung wirkt im Hintergrund.

## Bedingungen

### Merge-Konflikt und automatische Neuversuche

Scheitert der Merge eines Auftrags an einem Konflikt, wird der Auftrag automatisch neu eingeplant. Das geschieht höchstens zweimal. Beim dritten Konflikt wird er `blockiert`.

Der Zähler wird auf 0 gesetzt, wenn:

| Auslöser | Wirkung |
|---|---|
| Du klickst auf „Erneut versuchen“ (Seite „Aktionen“) | Der Zähler geht auf 0. Der Auftrag bekommt wieder zwei automatische Neuversuche. |
| Du übernimmst einen abgebrochenen Auftrag mit „In Sprint übernehmen“ | Der Zähler geht auf 0. |
| Die Freigabe wird gemerged | Der Zähler geht auf 0. |
| Ein Lauf endet mit dem Ergebnis „Erledigt“ | Der Zähler geht auf 0. |

Nicht zurückgesetzt wird der Zähler, während der Auftrag auf deine Freigabe wartet.

**Offen:** „Zurückweisen“ setzt den Zähler im Moment nicht zurück. Ein zurückgewiesener Auftrag, der danach konfliktet, hat also möglicherweise weniger automatische Neuversuche als erwartet.

### Phase „Vor dem Sprint“ bei Fehlern

Die Phase läuft einmal je Sprint, bevor dessen erster Auftrag startet. Scheitert ein Agent der Phase, gilt das so:

| Ursache | Zählt als Fehlversuch? | Was passiert |
|---|---|---|
| Agent nicht erreichbar, Fehler im Lauf (z. B. Ollama aus) | Ja | Der Sprint wartet 2 Minuten. Danach ein neuer Versuch. |
| Zweiter Fehlversuch | Ja | Der Sprint wartet 4 Minuten. |
| Dritter Fehlversuch | Ja | Die Phase wird aufgegeben. Die Aufträge starten ohne sie. |
| Nutzungslimit der Claude-CLI („monthly spend limit“ o. Ä.) | Nein | Der nächste Versuch ist der Zeitpunkt, den das Limit angibt (Reset). Die Phase wird nachgeholt. |
| Budget des Projekts erreicht | Nein | Die Phase wird nachgeholt, sobald das Budget wieder reicht. |

Die Pausen verdoppeln sich: 2 Minuten nach dem ersten Fehlversuch, 4 Minuten nach dem zweiten. Zusammen wartet der Sprint damit bis zu 6 Minuten, bevor die Aufträge ohne „Vor dem Sprint“ starten.

Während der Pause warten die Aufträge des Sprints. Sie werden nicht blockiert. Nach dem letzten Fehlversuch starten sie weiter ohne die Phase.

Erfolgreich abgeschlossen ist die Phase, wenn alle Agents ohne Fehler durchgelaufen sind. Dann wird der Zeitpunkt gelöscht und die Notizen am Sprint gespeichert.

### „Erneut versuchen“ und „Vor dem Sprint“

„Erneut versuchen“ setzt den Konflikt-Zähler zurück, nicht aber die Zähler von „Vor dem Sprint“. Die Phase des Sprints läuft nach ihren eigenen Regeln weiter.

## Was du siehst

| Situation | Was passiert |
|---|---|
| Auftrag ist konfliktiert und wird automatisch neu eingeplant | Der Auftrag geht auf „Geplant“. Die Konfliktmeldung steht im Feld `failure` und wird in der Auftragsansicht angezeigt. |
| Du klickst auf „Erneut versuchen“ bei einem blockierten Auftrag | Der Auftrag startet. Er hat wieder die vollen zwei automatischen Neuversuche bei Konflikten. |
| „Vor dem Sprint“ scheitert | Die Fehlermeldung steht im Log des Workers (Warnung je Fehlversuch). Sie landet nicht in der Oberfläche und nicht in den Anweisungen der Agents. |
| Nutzungslimit beim Agenten von „Vor dem Sprint“ | Kein Fehlversuch. Der Sprint wartet bis zum Reset. |

Die Zähler von „Vor dem Sprint“ (Versuche, nächster Zeitpunkt) sieht man nur in der Datenbank am Sprint (Spalten `pre_sprint_attempts` und `pre_sprint_next_at`). Eine Anzeige dafür gibt es nicht.

## Beispiel

Ein Auftrag hat zwei Merge-Konflikte hinter sich. Ein dritter Konflikt würde ihn sonst blockieren.

1. Der Auftrag wurde nach dem zweiten Konflikt automatisch neu eingeplant. Der Zähler steht bei 2.
2. Du klickst auf „Erneut versuchen“, weil der Entwickler die Konflikte gelöst hat. Der Zähler geht auf 0.
3. Ein weiterer Konflikt führt wieder zu einer automatischen Neueinplanung statt zu „Blockiert“.

Ein zweites Beispiel: Ollama fällt zwei Minuten aus, während die Phase „Vor dem Sprint“ läuft.

1. Der erste Versuch scheitert. Der Sprint wartet 2 Minuten.
2. Der zweite Versuch scheitert wieder, wenn Ollama noch nicht da ist. Der Sprint wartet 4 Minuten.
3. Ist Ollama dann erreichbar, läuft die Phase beim dritten Versuch durch. Die Aufträge starten mit den Notizen der Phase.

## Printscreens

Keine. Die Anwendung wurde für dieses Handbuch nicht gestartet, und die Änderung ist im Kern serverseitig. Die einzige Stelle in der Oberfläche ist der Knopf „Erneut versuchen“, der sich nicht geändert hat. Ein Bild davon ohne laufende Anwendung wäre nicht hilfreich. Die Abläufe lassen sich so prüfen:

1. Einen blockierten Auftrag mit „Erneut versuchen“ starten und einen Konflikt provozieren. Der Auftrag bekommt wieder automatische Neuversuche, statt sofort blockiert zu sein.
2. Den Ollama-Dienst kurz stoppen, während ein Sprint startet. Im Log stehen die Fehlversuche mit Abstand von 2 und 4 Minuten.

## Offen

- Die Tests des Auftrags wurden für dieses Handbuch nicht ausgeführt. Die Angaben stammen aus dem Quelltext und der Dokumentation des Entwicklers (`docs/wiederholungszaehler-zuruecksetzen-und-mit-pause-wiederholen-2026-10-28.md`).
- „Zurückweisen“ setzt den Konflikt-Zähler nicht zurück.
- Die Zähler von „Vor dem Sprint“ sind nicht in der Oberfläche sichtbar.
- Die Verzögerung des Sprint-Starts (bis zu 6 Minuten) ist nicht als Countdown dargestellt.
