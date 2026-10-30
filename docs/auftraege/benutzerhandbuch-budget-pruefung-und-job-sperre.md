# Benutzerhandbuch: Budget-Prüfung und Job-Sperre bei Fehlern

Gilt ab Sprint 23 (Auftrag c1fb5014, Bugfix). Betrifft Aufträge, deren Budgetprüfung fehlschlägt, Wartungs-Jobs, die das Zeitlimit überschreiten, und den Sprint-Abschluss.

## Was sich ändert

Bisher galt ein Budget als „nicht erreicht“, wenn die Abfrage selbst scheiterte. Dadurch starteten Agenten bei einer kurzen Datenbankstörung ohne Budgetprüfung. Außerdem gab ein Wartungs-Job seine Sperre frei, obwohl er noch lief. Der nächste Durchgang konnte dann parallel laufen und Aktionen doppelt ausführen, etwa einen Sprint zweimal abschließen.

Jetzt gilt:

- **Nicht prüfbares Budget startet nichts.** Scheitert die Budgetabfrage, startet der Agent nicht. Der Auftrag wird unterbrochen und wartet kurz.
- **Kein zweiter Versuch ohne Budgetprüfung.** Nach einem vorübergehenden Fehler des Agenten wird nur wiederholt, wenn das Budget erneut geprüft werden konnte.
- **Wartungs-Jobs geben ihre Sperre erst frei, wenn sie wirklich beendet sind.** Ein Job, der das Zeitlimit reißt, läuft nicht still weiter, während schon der nächste Durchgang startet.
- **Sprint-Abschluss ist einmalig.** Ein zweiter Abschluss desselben Sprints ändert nichts und sendet keine zweite Nachricht und keinen zweiten Git-Sync.

Eine neue Bedienung gibt es nicht. Die Änderung zeigt sich im Auftrag (Hinweis in der Auftragsansicht, Feld `failure`) und im Status der Wartungs-Jobs (nur über die API). Deshalb gibt es hier keine Printscreens (siehe unten).

## Bedingungen

### Budget-Prüfung vor einem Agenten-Schritt

| Ergebnis der Budgetprüfung | Was passiert mit dem Agenten | Was passiert mit dem Auftrag |
|---|---|---|
| Budget ist frei | Der Agent startet. | Läuft normal weiter. |
| Budget ist erreicht (Tages-, Sprint-, Auftrags- oder Rollenlimit) | Der Agent startet nicht. | Wird `blockiert` mit „Budget erreicht“, wie bisher. Kein Bug. |
| Budget ist **nicht prüfbar** (z. B. Datenbank kurz weg) | Der Agent startet nicht. | Wird **unterbrochen**: zurück auf „Geplant“, Ursache in `failure`, Pause von 5 Minuten. |

Die Pause gilt nur für diesen Fall. Danach setzt derselbe Agent fort, und bereits erledigte Schritte bleiben erhalten.

### Hinweis am Auftrag bei nicht prüfbarem Budget

Die Ursache steht im Feld `failure` und wird in der Auftragsansicht angezeigt. Der Text beginnt mit „Unterbrochen: Das Budget liess sich nicht prüfen“ und nennt den Agenten. Er endet mit dem Hinweis, dass der Auftrag in 5 Minuten wieder startet.

Zusätzlich steht im Ablauf ein unterbrochener Schritt des Agenten mit derselben Ursache. Der Schritt zeigt, wo der Auftrag stehen geblieben ist.

Die 5-Minuten-Pause selbst gibt es nur als Zeitstempel im Auftrag. Die Oberfläche zeigt sie nicht als Countdown an.

### Vorübergehender Fehler des Agenten

Ein Modell, das kurz nicht erreichbar ist oder überlastet ist, wird nach 30 s einmal wiederholt. Vor dem zweiten Versuch wird das Budget erneut geprüft:

- **Budget frei:** zweiter Versuch. Tokens und Kosten beider Versuche werden zusammengezählt.
- **Budget erreicht:** kein zweiter Versuch. Der Auftrag wird `blockiert` wie bei jedem erreichten Limit.
- **Budget nicht prüfbar:** kein zweiter Versuch. Der Schritt wird unterbrochen, der Auftrag wie oben behandelt. Die Tokens und Kosten des ersten Versuchs bleiben am Schritt erhalten.

### Beobachter-Agenten

Die Agenten „Bei abgeschlossen“ und „Bei abgelehnt“ starten nicht, wenn das Budget nicht prüfbar ist.

### Wartungs-Jobs und Zeitlimit

Jeder Wartungs-Job hat ein Zeitlimit (`timeoutSeconds` in der Konfiguration, höchstens 300 s). Überschreitet er es:

1. Der Job erhält das Abbruchsignal.
2. Der Worker wartet bis zu **20 s**, bis der Job wirklich endet.
3. Endet er in dieser Zeit, wird die Sperre freigegeben und der Job ist wieder einplanbar.
4. Endet er nicht, steht der Job als `failed` mit dem Hinweis „läuft noch“. Die Sperre bleibt stehen. Im Log steht eine Warnung.

Solange der Job in diesem Worker noch läuft, startet der nächste Durchgang ihn nicht erneut, auch nach Ablauf der Sperre. Endet er später doch, gibt er die Sperre selbst frei.

Für andere Worker ist die Sperre höchstens 330 s lang (höchstes Zeitlimit 300 s plus 30 s Reserve), unabhängig vom eingestellten Zeitlimit des Jobs. Danach kann ein anderer Worker den Job übernehmen, auch wenn der Task im ersten Worker noch läuft (siehe „Offen“).

### Sprint-Abschluss

- Ein Sprint wird nur einmal abgeschlossen. Ist er schon abgeschlossen, passiert nichts. Es gibt keine zweite Berichts-Nachricht, keinen zweiten Git-Sync und keine zweite Push-Nachricht.
- Der Job `close_old_sprints` prüft vor jedem Abschluss, ob er abgebrochen werden soll. Nach dem Zeitlimit schließt er keinen weiteren Sprint.
- Der Job schließt nie einen Sprint mit offenen oder laufenden Aufträgen. Das galt schon vorher.

### Sprint-Limit und Bugfix

Die Abgrenzung des Sprintbudgets (nur Läufe der Sprint-Aufträge bis Sprintende) bleibt unverändert. Der Fehlerfall „Budget nicht prüfbar“ gilt auch dort: Ein Sprint-Auftrag startet nicht, solange das Sprintbudget nicht geprüft werden kann. Siehe `docs/benutzerhandbuch-sprintbudget-nur-sprint-auftraege.md`.

## Was du siehst

| Situation | Was passiert |
|---|---|
| Datenbank kurz weg, Auftrag will einen Agenten starten | Der Auftrag geht auf „Geplant“ zurück. Die Auftragsansicht zeigt „Unterbrochen: Das Budget liess sich nicht prüfen …“ in `failure`. Nach 5 Minuten läuft er weiter. |
| Datenbank wieder da | Der Auftrag läuft nach der Pause weiter, am selben Agenten. |
| Wartungs-Job überschreitet das Zeitlimit und endet innerhalb von 20 s danach | Status wird geschrieben, Sperre wird freigegeben. |
| Wartungs-Job überschreitet das Zeitlimit und endet nicht | Status `failed` mit „läuft noch“. Er läuft nicht erneut, bis er endet oder der Task von Hand beendet wird. |
| Sprint wird ein zweites Mal abgeschlossen | Keine Wirkung. Keine zweite Nachricht. |

Die Wartungs-Jobs sieht man über `GET /api/scheduled-jobs` (nur Administratoren). Eine Oberfläche dafür gibt es nicht.

## Beispiel

Ein Auftrag läuft im aktiven Sprint. Der Agent „Entwickler“ soll starten.

- Die Abfrage des Budgets schlägt fehl, weil die Datenbank kurz nicht erreichbar ist. Der Entwickler startet nicht.
- Der Auftrag wird unterbrochen, geht zurück auf „Geplant“ und erhält den Hinweis in `failure`.
- Nach 5 Minuten prüft der Worker das Budget erneut. Ist es frei, läuft der Entwickler weiter. Ist es erreicht, wird der Auftrag `blockiert`.

## Printscreens

Keine. Die Änderung ist im Kern serverseitig, und die Oberfläche hat keinen neuen Bedienschritt. Die Anwendung wurde für dieses Handbuch nicht gestartet, daher gibt es keine Aufnahmen. Ein Bild würde nur die Auftragsansicht mit dem Feld `failure` zeigen, und das ließe sich ohne laufende Datenbank nicht sinnvoll erzeugen.

Prüfbar ist die Änderung über das Verhalten:

1. Einen Auftrag starten und den Budget-Check kurz scheitern lassen (z. B. Datenbank stoppen). Der Auftrag steht danach auf „Geplant“ mit dem Hinweis unter `failure`, und kein Agent läuft.
2. Einen Wartungs-Job mit kurzem Zeitlimit und langsamer Aufgabe anstoßen. Der Status ist `failed` mit „läuft noch“, solange die Aufgabe nicht endet. Die Statusabfrage läuft über `GET /api/scheduled-jobs` als Administrator.
3. Einen Sprint zweimal abschließen. Die zweite Aktion bleibt ohne Wirkung.

## Offen

- Die Tests wurden in dieser Sitzung nicht ausgeführt. Die Angaben dazu stammen aus der Dokumentation des Entwicklers.
- Der Countdown der 5-Minuten-Pause ist in der Oberfläche nicht sichtbar.
- Ein Wartungs-Job, der nie endet, belegt im eigenen Worker seine Sperre, bis der Task endet. Dann ist ein Eingriff von Hand nötig.
- Offen: Nach Ablauf der Sperre (höchstens 330 s) kann ein anderer Worker den Job übernehmen, während der Task im ersten Worker noch läuft. Der Code verhindert das nicht. Bei nur einem Worker tritt es nicht auf.
