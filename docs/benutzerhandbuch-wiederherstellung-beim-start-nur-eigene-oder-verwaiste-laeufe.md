# Benutzerhandbuch: Wiederherstellung beim Start nur für eigene oder verwaiste Läufe

Dieses Kapitel beschreibt, was der Worker beim Start mit Läufen macht, die noch als „läuft“ in der Datenbank stehen, und wann er fremde Läufe in Ruhe lässt. Auslöser ist der Auftrag 027c0e61 (Bugfix, Sprint 23) aus dem Code-Review vom 21.10.2026.

> **Printscreens:** keine. Die Änderung liegt im Worker und in der Datenbank, nicht in der Oberfläche. Sichtbar wird sie nur im Worker-Log und darin, ob ein Auftrag neu eingeplant wurde oder nicht. Für Aufnahmen müssten App, Datenbank und Worker laufen; das ist für diesen Auftrag nicht geschehen.

---

## 1. Was vorher passiert ist

Beim Start stellte der Worker alle Läufe mit Status „läuft“ im ganzen System auf „gescheitert“ und plante die Aufträge neu ein. Dabei zählte nicht, welcher Worker den Lauf gestartet hatte. Startete also eine zweite Installation oder ein Neustart, während der alte Worker noch arbeitete, brach er die Agents des laufenden Workers ab. Dazu beendete er Prozesse mit passender Startzeit, auch wenn sie einem lebenden anderen Worker gehörten.

## 2. Was jetzt passiert

### 2.1 Jeder Worker hat eine Kennung und ein Lebenszeichen

- **Kennung:** Jeder Worker trägt eine feste ID aus Rechner, Installationsordner und Bereich, z. B. `mac:/…/AIdeation/source:alle`. Ein Neustart derselben Installation behält die ID. Eine Kopie des Projekts (z. B. `AIdeation/agent`) bekommt eine eigene.
- **Lebenszeichen:** Der Worker meldet sich alle 20 Sekunden in der Datenbank. Nach 90 Sekunden ohne Meldung gilt er als beendet.
- Jeder neue Lauf, jeder Schritt und jeder Prozess trägt die ID des Workers, der ihn gestartet hat.

### 2.2 Was der Worker beim Start aufräumt

| Lauf oder Prozess gehört … | Was beim Start passiert |
| --- | --- |
| dem eigenen Vorgänger (gleiche ID) | wird aufgeräumt: Lauf und Schritte „gescheitert“, Prozess beendet, Auftrag wieder „Geplant“ |
| einem Worker ohne frisches Lebenszeichen (beendet oder abgestürzt) | wird aufgeräumt wie oben |
| einem **lebenden** anderen Worker | bleibt unberührt: Lauf, Schritte und Prozesse laufen weiter |
| keiner Kennung (Altbestand von vor diesem Stand) | wird nur aufgeräumt, wenn der Projekt-Heartbeat des Projekts alt ist. Prozesse ohne Kennung werden immer aufgeräumt |

Ein Auftrag wird nur neu eingeplant, wenn beim Aufräumen kein Prozess mehr lebt. Meldet das Beenden eines Prozesses „fehlgeschlagen“, bleibt der Auftrag stehen und der Prozesseintrag wird beim nächsten Versuch erneut geprüft.

### 2.3 Läufe ohne Halter

Läuft ein Lauf noch als „läuft“, obwohl kein Auftrag dieses Workers ihn mehr hält (z. B. weil der Abschluss an der Datenbank scheiterte), räumt der Worker ihn während des Betriebs auf. Dafür gilt eine Grenze von 5 Minuten ohne Lebenszeichen. Läufe eines anderen, lebenden Workers bleiben dabei stehen.

## 3. Bedingungen

- **Nur eigene Läufe nach Neustart:** Ein Worker mit derselben ID räumt seine eigenen Läufe auch dann auf, wenn das Lebenszeichen frisch ist. Dieser Fall ist der Neustart der Installation.
- **Nur mit fremdem, lebendem Worker:** Der Lauf bleibt unberührt, solange der andere Worker alle 90 Sekunden oder öfter ein Lebenszeichen schreibt.
- **Zwei Dauer-Worker derselben Installation im selben Bereich:** Sie hätten dieselbe ID und würden sich gegenseitig aufräumen. Für den Bereich `--all` verhindert das die Sperre aus dem Worker-Start. Ohne `--all` gibt es diesen Schutz nicht (siehe Abschnitt 5).
- **Ausführung mit „failed“:** Scheitert das Beenden eines Altprozesses, wird in diesem Durchgang nichts neu eingeplant.

## 4. Beispiel

1. Worker A läuft auf dem Mac und bearbeitet den Auftrag „Anmeldung prüfen“.
2. Du startest in `AIdeation/agent` einen zweiten Worker B.
3. B liest die Läufe. Der Lauf von A hat eine andere ID und ein frisches Lebenszeichen. B lässt ihn in Ruhe.
4. A arbeitet weiter, der Auftrag bleibt „In Arbeit“.

Beendest du A hart (z. B. Rechner-Absturz) und startest ihn neu, gilt das so: Nach 90 Sekunden ohne Lebenszeichen ist A für B „beendet“. B räumt den Lauf auf, und der Auftrag wird neu eingeplant. Startet A selbst neu, mit derselben ID, räumt er seine eigenen Reste auf.

## 5. Fehlerbehebung und offene Punkte

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| Ein Auftrag steht nach einem Neustart noch „In Arbeit“ | Der Vorgänger hatte noch ein frisches Lebenszeichen. Nach 90 Sekunden ohne Lebenszeichen räumt der nächste Start ihn auf. Den Worker-Log-Eintrag des Starts prüfen. |
| Auftrag wird im Container nicht neu eingeplant | Der Container hat bei jedem Start einen anderen Hostnamen, daher eine andere ID. Dann gilt der alte Lauf erst nach 90 Sekunden als verwaist. Abhilfe: `DEV_LOG_WORKER_ID` in der Umgebung des Containers fest setzen. |
| Lauf steht als „läuft“ und seit mehr als 5 Minuten ohne Ereignisse | Der Worker beendet ihn während des Betriebs nur, wenn kein anderer lebender Worker ihn hält. Bei langen Schritten ohne Verlaufseinträge kann das zu früh sein. Den Schritt im Worker-Log prüfen. |
| Zwei Worker derselben Installation räumen sich gegenseitig auf | Die ID ist identisch. Nur einen Dauer-Worker je Installation betreiben, oder für den zweiten `DEV_LOG_WORKER_ID` mit einem eigenen Wert setzen. |

### Offen (auch in der Entwicklerdoku vermerkt)

- **Worker-ID ohne `--all`:** Ob für den Bereich ohne `--all` eine eigene Sperre nötig ist, ist offen. Der Reviewer bewertet das.
- **`closeOrphanedRuns` auf PostgreSQL:** Die Abfrage läuft dort erst seit diesem Stand. Lange Schritte ohne Verlaufseinträge sind noch nicht geprüft (Tester).
- **Tests:** Die Tests für diesen Stand (`src/runner/worker-recovery.test.ts`) hat der Entwickler laut Bericht bestanden. Ich habe sie für dieses Kapitel nicht selbst ausgeführt.

## 6. Grenzen dieses Kapitels

- Die Beschreibung stammt aus dem Quelltext (`src/runner/worker-identity.ts`, `src/runner/runner.ts`, `src/db/migrations.ts`, Version 16) und aus der Entwicklerdoku [`wiederherstellung-beim-start-nur-eigene-oder-verwaiste-laeufe-2026-10-28.md`](wiederherstellung-beim-start-nur-eigene-oder-verwaiste-laeufe-2026-10-28.md). Im Betrieb habe ich das nicht beobachtet.
- Die Einträge „Bug-Wächter“ zu diesem Auftrag sind Abbrüche der Claude-CLI wegen des Ausgabenlimits, keine Fehlerbeschreibung. Sie sind deshalb nicht als Inhalt übernommen.
- Verweise: [`unterbrochene-auftraege`](benutzerhandbuch-unterbrochene-auftraege.md) für den Arbeitsordner nach einer Unterbrechung; Laufzeitdetails in [`laufzeit.md`](laufzeit.md) und Datenmodell in [`erm.md`](erm.md).
