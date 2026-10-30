# Benutzerhandbuch: CI-Spiegel vor dem Pull Request

Dieses Kapitel beschreibt die Vorprüfung, die die Sprint-Sicherung im PR-Modus (`issues+pr`) vor jedem Push ausführt. Sie führt die Prüfschritte aus `.github/workflows/ci.yml` lokal aus. Ist einer rot, wird kein Pull Request geöffnet und es entsteht ein Bug. Die Beschreibung stammt aus dem Quelltext (`src/runner/git-sync/ci-mirror.ts`, Aufruf in `src/runner/git-sync/sprint-sync.ts`, Funktion `pushSprint`) und aus den Tests in `src/runner/git-sync/ci-mirror.test.ts` und `src/runner/git-sync.test.ts` (Block „CI-Spiegel“).

> **Printscreens: offen.** In der Sitzung, in der dieses Kapitel entstand, gab es keinen Browser und keine laufende App. Die Aufnahmen fehlen daher. Vorgesehen sind folgende Bilder, aufzunehmen auf einem Host mit App, Datenbank und Worker:
> - **[Bild: CI-Spiegel grün]** Sprint-Log mit „CI-Spiegel grün (lint, format:check, typecheck, test:unit).“ und danach dem Pull-Request-Link.
> - **[Bild: CI-Spiegel rot]** Sprint-Log mit „Push abgelehnt: CI-Spiegel rot bei `npm run …` (Exit-Code …) – kein Pull Request.“ und der Sprint-Status „Git-Sicherung gescheitert“.
> - **[Bild: Bug „CI-Spiegel rot vor Pull Request von „…““]** Bugliste mit dem Eintrag, Priorität „high“, Quelle „github“.
>
> Der Text unten ist aus dem Code und den Tests abgeleitet und ist nicht am Bildschirm geprüft.

Die Oberfläche ändert sich nicht. Du siehst das Ergebnis im Sprint-Log, in der Git-Sicherung und in der Bugliste.

---

## 1. Wozu der CI-Spiegel dient

Die echte CI auf GitHub prüft jeden Pull Request erst nach dem Push. Ein roter Lauf erscheint dann am Pull Request, nicht vorher. Der CI-Spiegel prüft dieselben Schritte schon vor dem Push. So landet ein offensichtlich roter Stand nicht als Pull Request.

Der CI-Spiegel **ersetzt die echte CI nicht**. Er ist eine Vorprüfung. Maßgeblich bleibt der Lauf auf GitHub.

## 2. Wann er läuft

Der CI-Spiegel läuft nur, wenn alle drei Bedingungen zutreffen:

- Der Sprint ist im **PR-Modus** (`issues+pr`). Im Modus `aus` oder `issues` (direkter Merge) läuft er nicht.
- Der Worker führt den Push des Sprint-Branches aus. Das passiert in zwei Fällen:
  - beim **Abschluss des Sprints** (der Push öffnet den Pull Request), oder
  - bei der **Nachbesserung im Review** (der Push aktualisiert den offenen Pull Request).
- Das Test-Gate (die Projekt-Testbefehle) ist vorher gelaufen.

Die Reihenfolge ist: Test-Gate, dann CI-Spiegel, dann Push und Pull Request. Der CI-Spiegel ergänzt das Test-Gate und ersetzt es nicht.

## 3. Welche Schritte geprüft werden

Der Worker liest `.github/workflows/ci.yml` bei **jedem Lauf neu**. Er übernimmt nur Zeilen der Form `run: npm run …`, und davon nur diese vier Schritte, in der Reihenfolge der Datei:

| Schritt | Ausgeführt |
| --- | --- |
| `npm run lint` | ja |
| `npm run format:check` | ja |
| `npm run typecheck` | ja |
| `npm run test:unit` | ja |
| `npm ci`, `docker …`, `npx … playwright`, `npm run build:ui`, `npm run test:e2e` | nein |

Kommt ein Schritt in mehreren Jobs der Datei vor, läuft er einmal. Ändert sich die Workflow-Datei, folgt der Spiegel ihr beim nächsten Lauf, ohne dass eine Liste im Programm gepflegt werden muss.

Fehlt die Datei oder enthält sie keinen der vier Schritte, steht im Sprint-Log „CI-Spiegel übersprungen“. Der Push läuft dann wie bisher weiter.

## 4. Ergebnis je Fall

| Fall | Was passiert | Sprint-Log |
| --- | --- | --- |
| Alle Schritte grün | Push, dann Pull Request wie bisher | „CI-Spiegel grün (lint, format:check, typecheck, test:unit).“ |
| Ein Schritt rot (außer `test:unit` ohne Datenbank) | **Kein Push, kein Pull Request, kein Merge.** Die Git-Sicherung steht auf „gescheitert“. Es entsteht ein Bug, oder es gibt schon einen offenen. | „Push abgelehnt: CI-Spiegel rot bei `npm run …` (Exit-Code …) – kein Pull Request. Bug angelegt.“ bzw. „… Bug dazu ist schon offen.“ |
| `test:unit` rot, weil keine Datenbank erreichbar ist | Kein Bug. Der Schritt gilt als „nicht prüfbar“. Push und Pull Request laufen weiter. | „CI-Spiegel: `npm run test:unit` nicht prüfbar (keine Datenbank erreichbar) – die echte CI prüft ihn.“ |
| `test:unit` grün, aber ohne Datenbank | Kein Bug, Push und Pull Request laufen weiter. | „… grün, Datenbank-Tests nicht prüfbar (keine Datenbank).“ |

Der Spiegel hält beim **ersten** roten Schritt an. Die Schritte danach laufen nicht mehr.

## 5. Der Bug bei einem roten Schritt

Bei einem roten Schritt legt der Worker genau einen Bug an:

- **Titel:** „CI-Spiegel rot vor Pull Request von „<Sprintname>““. Höchstens 180 Zeichen.
- **Priorität:** `high`.
- **Quelle:** `github`.
- **Text:** Eine Zeile „Fehlgeschlagener Schritt: `npm run …` (Exit-Code …)“, dazu ein gekürzter Log-Auszug aus dem fehlgeschlagenen Schritt.
- **Log-Auszug:** höchstens 60 Zeilen oder 3000 Zeichen. Zugangsdaten sind maskiert.

**Eine Meldung pro Sprint und Schritt.** Ist für denselben Sprint und Schritt schon ein offener Bug vorhanden, entsteht kein zweiter, auch wenn der nächste Lauf wieder rot ist. Ein roter Lauf für einen anderen Schritt desselben Sprints legt dagegen einen eigenen Bug an.

Der Bug wird **nicht automatisch geschlossen**, auch nicht nach einem späteren grünen Lauf. Schließe ihn von Hand, wenn der Fehler behoben ist.

## 6. Was du tun musst

1. Den Bug in der Bugliste öffnen und den Schritt und den Log-Auszug lesen.
2. Den Fehler im Sprint-Branch beheben. Das geht über die Nachbesserung im Review oder über einen neuen Auftrag im Sprint.
3. Die Git-Sicherung erneut starten. Der CI-Spiegel läuft dann vor dem Push wieder.
4. Den Bug schließen, sobald der Schritt grün ist.

Der Sprint steht auf „Git-Sicherung gescheitert“ (`failed`). Der Worker wiederholt die Sicherung nicht von selbst; sie läuft erst wieder, wenn du sie erneut startest.

## 7. Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| Sprint-Log: „CI-Spiegel übersprungen: keine .github/workflows/ci.yml.“ | Im Projekt fehlt die Workflow-Datei. Ohne sie gibt es nichts zu spiegeln. Der Push läuft wie bisher. |
| Sprint-Log: „CI-Spiegel übersprungen: … enthält keine spiegelbaren Schritte.“ | Die Datei hat keinen der vier Schritte. Prüfen, ob die Zeilen dort als `run: npm run …` stehen. |
| Sprint-Log: „Push abgelehnt: CI-Spiegel rot bei `npm run lint`“ (oder einem anderen Schritt) | Den Fehler laut Bug beheben und die Git-Sicherung erneut starten. |
| Ein roter Lauf erzeugt keinen neuen Bug | Es gibt schon einen offenen Bug für denselben Sprint und Schritt. Ihn öffnen, den Stand prüfen, schließen, dann neu starten. |
| `test:unit` ist im Log „nicht prüfbar“, obwohl die Datenbank laufen sollte | Der Worker erreicht die Datenbank nicht. Die echte CI prüft den Schritt, sobald der Pull Request läuft. |

## 8. Grenzen

- **Nur PR-Modus.** Im direkten Merge gibt es keinen CI-Spiegel. Das ist so gewollt. Eine Umstellung wäre eine Entscheidung des Auftraggebers und ist nicht umgesetzt.
- **Keine Datenbank, kein Test.** Ohne erreichbare Datenbank wird `test:unit` nicht geprüft, sondern als „nicht prüfbar“ vermerkt. Das ist kein grünes Ergebnis. Die echte CI bleibt maßgeblich.
- **Nur vier Schritte.** Der Spiegel prüft keine Container, keine Browser-Tests (`test:e2e`), keinen Oberflächen-Build (`build:ui`) und keinen Schritt mit `npm ci`.
- **Laufzeit.** Die vier Schritte verlängern die Sicherung im PR-Modus. Pro Schritt gilt dasselbe Zeitlimit wie beim Test-Gate (45 Minuten).
- **Projektcode läuft.** Die Befehle sind Projektcode. Sie laufen nur mit dem gefilterten Environment: AIdeation-Zugänge und `DEV_LOG_*`-Variablen sind darin nicht enthalten.

## Verweise

- [`docs/ci.md`](ci.md), Abschnitt „CI-Spiegel vor dem Pull Request“ (technische Beschreibung)
- [`workflows.md`](workflows.md), Abschnitt „GitHub-Brücke (`github_mode`)“, Punkt „PR-Modus“
- [`benutzerhandbuch-live-schalten-pr-modus.md`](benutzerhandbuch-live-schalten-pr-modus.md): Was nach dem Merge passiert
