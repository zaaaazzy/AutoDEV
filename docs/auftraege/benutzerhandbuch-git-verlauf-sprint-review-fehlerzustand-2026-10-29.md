# Benutzerhandbuch: Git-Verlauf bleibt bei Fehlern sichtbar, Sprint-Review nur bei offenen Sprints

Stand: 29.10.2026. Auftrag c30ff9d9 (Bugfix) „Git-Verlauf und Sprint-Review: Fehlerzustand und weniger Polling“. Grundlage: `docs/git-verlauf-sprint-review-fehlerzustand-polling-2026-10-29.md`.

---

## 1. Was sich ändert

Zwei Stellen der Oberfläche verhalten sich jetzt anders:

1. **Git-Verlauf im Dashboard:** Scheitert der Abruf (z. B. weil der Worker neu startet), verschwindet der Verlauf nicht mehr. Du siehst den letzten Stand und einen Hinweis, dass der Abruf gerade nicht klappt. Früher blieb das Panel dabei leer und meldete „Noch kein Git-Verlauf“.
2. **Sprint-Review im Sprint-Detail:** Der Review-Block (Auswahl des Review-Containers) erscheint nur noch bei offenen Sprints. Bei abgeschlossenen oder abgebrochenen Sprints fehlt er. Außerdem fragt die Oberfläche die Review-Stände nur einmal für alle Blöcke gemeinsam ab, statt jeder aufgeklappten Sprint-Karte einzeln.

Es kommen keine neuen Schaltflächen dazu. Die Funktionen des Git-Verlaufs (Commits, Branches, GitHub-Link) und des Sprint-Reviews bleiben gleich.

---

## 2. Git-Verlauf im Dashboard

### 2.1 Bedingungen

| Situation | Was du siehst |
|---|---|
| Erster Abruf läuft noch | „Git-Verlauf wird geladen …“ |
| Abruf erfolgreich, Projekt hat Commits | Liste der Commits mit Spuren, Kopfzeile „N Commits · M Branches“ |
| Abruf erfolgreich, Projekt hat noch keinen Verlauf | „Noch kein Git-Verlauf – der Worker liest ihn jede Minute aus dem Projektordner.“ |
| Abruf schlägt fehl, es gab vorher einen Stand | Oben roter Hinweis „Git-Verlauf gerade nicht erreichbar – angezeigt wird der letzte Stand. Nächster Versuch in einer Minute.“ Darunter bleibt der alte Verlauf stehen. |
| Abruf schlägt fehl, noch nie ein Stand geladen | Nur der Hinweis „Git-Verlauf gerade nicht erreichbar. Nächster Versuch in einer Minute.“ Die Meldung „Noch kein Git-Verlauf“ erscheint dann nicht. |
| Abruf klappt wieder | Hinweis verschwindet, der Verlauf wird aktualisiert. |

### 2.2 Wann abgefragt wird

- Der Verlauf wird jede Minute neu geladen, aber **nur, solange der Browser-Tab sichtbar ist**. In einem verborgenen Tab läuft kein Abruf.
- Kommt man zurück in den Tab, wird nachgeladen.
- Die Rand-Dekoration neben dem Dashboard bleibt bei einem Fehler stehen. Sie wird nur beim Wechsel des Projekts zurückgesetzt.

### 2.3 Wann der Verlauf leer wird

Der Verlauf wird nur leer, wenn du das **Projekt wechselst**. Ein Fehler löscht ihn nicht.

### 2.4 Was du tun kannst

- Hinweis erscheint: Nichts tun. Der Worker wird neu gestartet oder der Abruf klappt in der nächsten Minute.
- Hinweis bleibt länger stehen: Prüfen, ob der Worker läuft. Der Verlauf kommt vom Worker, der ihn aus dem Projektordner liest. Wie man den Worker-Status in der Oberfläche sieht, habe ich nicht geprüft.
- Der Link „GitHub ↗“ und die Commit-Links öffnen sich in einem neuen Tab. Commits, die noch nicht gepusht sind, haben keinen Link. Der Tooltip sagt „Noch nicht gepusht – nur lokal vorhanden“.

---

## 3. Sprint-Review im Sprint-Detail

### 3.1 Bedingungen

Der Block „Sprint-Review“ erscheint nur, wenn **beide** Bedingungen gelten:

1. Im Projekt ist ein Review-Befehl hinterlegt.
2. Der Sprint hat den Status **Geplant**, **Aktiv** oder **Review**.

| Sprint-Status | Review-Block |
|---|---|
| Geplant (`planned`) | wird angezeigt (wenn Befehl gesetzt) |
| Aktiv (`active`) | wird angezeigt (wenn Befehl gesetzt) |
| Review (`review`) | wird angezeigt (wenn Befehl gesetzt) |
| Abgeschlossen (`completed`) oder abgebrochen (`cancelled`) | wird **nicht** angezeigt, es wird auch nichts abgefragt |

Ohne Review-Befehl im Projekt fehlt der Block in allen Status. Die Status-Bezeichnungen in der Oberfläche habe ich nicht geprüft; die Tabelle nennt die Werte aus dem Code.

### 3.2 Was sich beim Abfragen ändert

- Die Liste der laufenden Review-Container wird **einmal für alle Blöcke** gemeinsam abgefragt, alle 5 Sekunden. Vorher hat jeder aufgeklappte Sprint seine eigene Abfrage gestartet.
- Der Abruf der Commits für den jeweiligen Sprint läuft weiterhin pro Sprint, aber nur bei sichtbarem Tab.
- Sobald der letzte Block verschwindet (z. B. weil du die Sprint-Karte zuklappst), endet die gemeinsame Abfrage.

### 3.3 Was du tun kannst

- Sprint ist geplant, aktiv oder in Review: Block wie gewohnt nutzen, um einen Stand zu starten und den Container zu öffnen.
- Sprint ist abgeschlossen: Der Block fehlt. Das ist gewollt.
- Mehrere Sprints aufgeklappt: Es gibt nur noch eine Abfrage der Container-Stände, statt eine je Sprint.

---

## 4. Beispiel

Der Worker startet neu, während du das Dashboard offen hast.

1. Der Verlauf zeigt 40 Commits, wie vorher.
2. Der nächste Abruf schlägt fehl. Oben erscheint der Hinweis „Git-Verlauf gerade nicht erreichbar – angezeigt wird der letzte Stand.“ Die Liste bleibt sichtbar.
3. Der Worker ist wieder da. Eine Minute später ist der Hinweis weg und der Verlauf aktualisiert.

Ein Sprint mit Status `completed` zeigt im Detail keinen Review-Block, auch wenn der Projekt-Review-Befehl gesetzt ist.

---

## 5. Fehlerbehebung

| Problem | Ursache | Was tun |
|---|---|---|
| Hinweis „nicht erreichbar“ bleibt dauerhaft | Worker läuft nicht oder ist nicht erreichbar | Worker-Status prüfen. Der Hinweis verschwindet, sobald ein Abruf klappt. |
| Dashboard zeigt „Noch kein Git-Verlauf“ | Projekt hat wirklich keinen Verlauf, oder der Worker hat den Ordner noch nicht gelesen | Eine Minute warten. Bleibt es leer, Projektordner prüfen. |
| Review-Block fehlt bei einem offenen Sprint | Im Projekt ist kein Review-Befehl gesetzt | Review-Befehl im Projekt hinterlegen (Ort in der Oberfläche nicht geprüft). |
| Review-Block fehlt bei einem abgeschlossenen Sprint | Gewollt, Abschnitt 3.1 | Keine Aktion nötig. |
| Review-Stände aktualisieren sich langsamer | Gemeinsame Abfrage alle 5 Sekunden, nur bei sichtbarem Tab | Tab in den Vordergrund holen. |

---

## 6. Für Entwickler

- Der Zustand des Git-Verlaufs (`graph`, `loaded`, `error`) liegt in `frontend/src/app/features/dashboard/git-graph.ts` (`nextGitGraphState`). Bei einem Fehler wird nur `error` gesetzt.
- `frontend/src/app/core/shared-poll.ts` (`sharedPoll`): ein Takt für beliebig viele Abnehmer, nutzt `visibleInterval`.
- `ReviewLaunchService.watchSlots()` meldet sich am gemeinsamen Poll an. `SprintReviewComponent` ruft `loadSlots()` nicht mehr selbst im Takt auf.
- Sichtbarkeit des Sprint-Reviews: `sprintReviewable(status)` in `features/sprints/review-launch.ts`.
- Neue Anzeigen mit Review-Containern sollten `launch.watchSlots()` nutzen und keinen eigenen Takt anlegen.
- Tests: `core/shared-poll.spec.ts`, `features/dashboard/git-graph-state.spec.ts`, `features/sprints/review-launch.spec.ts`.

---

## 7. Offen und nicht geprüft

- **Printscreens:** Keine. Für den Fehlerhinweis und den Review-Block bräuchte man eine laufende App mit Datenbank und Worker. Die Abschnitte oben beschreiben nur, was der Code tut. Bilder werden nachgereicht, wenn die Oberfläche im Browser geprüft wurde.
- **Browser-Prüfung steht aus** (Wunsch des Entwicklers):
  1. Worker stoppen: Verlauf bleibt stehen, Fehlerhinweis erscheint.
  2. Mehrere Sprints aufklappen: nur ein `/api/review-slots`-Abruf alle 5 Sekunden.
  3. Abgeschlossener Sprint: kein Review-Block.
- **Tests:** Die Unit-Tests wurden vom Entwickler gemeldet, für dieses Kapitel nicht erneut ausgeführt.
- **Tokenstand im Dashboard** und der Hinweis, dass der Verlauf bei einem Projektwechsel leer wird, sind nicht Teil dieses Auftrags.
