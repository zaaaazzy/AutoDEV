# Benutzerhandbuch: Sprint-Branch beim Start festhalten

Dieses Kapitel beschreibt, welchen Git-Branch ein Sprint bekommt und was passiert, wenn du den Sprint umbenennst. Auslöser ist der Bugfix 97fdce0c (Code-Review vom 21.10.2026): Der Branch wurde bei jedem Zugriff aus dem aktuellen Namen gebildet. Eine Umbenennung ließ den Sprint auf einem neuen Branch von `main` weiterarbeiten, und beim Abschluss kam nur der Teil nach der Umbenennung nach `main`.

> **Printscreens:** keine. In dieser Sitzung gab es keinen Browser und keine laufende App, daher sind keine Aufnahmen entstanden. Die Beschreibung stammt aus dem Quelltext (`src/api/sprints.ts`, `src/db/migrations.ts` Migration 13, `src/runner/git-sync/sprint-sync.ts`) und aus [`workflows.md`](../workflows.md), Abschnitt „Sprint-Branch beim Start festgehalten“. Für Aufnahmen müssten App, Datenbank und Browser laufen.

---

## 1. Was vorher passiert ist

Der Branch eines Sprints hieß `sprint/<Name>`, und der Name wurde jedes Mal neu gelesen. Wurde ein Sprint während der Arbeit umbenannt, suchte der Worker den neuen Branch, fand ihn nicht und legte ihn von `main` an. Die Aufträge vor der Umbenennung lagen auf dem alten Branch. Beim Abschluss kam nur der neue Teil nach `main`, und der Tag zeigte auf einen unvollständigen Stand. Fehlte der Branch ganz, sicherte die Git-Sicherung den aktuellen Branch und meldete trotzdem „erledigt“.

## 2. Was jetzt passiert

### 2.1 Der Branch wird beim Start festgehalten

| Was du tust | Was mit dem Branch passiert |
| --- | --- |
| Sprint anlegen | Kein Branch. Ein geplanter Sprint hat noch keinen Branch. |
| Sprint starten (Status „Geplant“ → „Aktiv“) | Der Branch wird einmal vergeben: `sprint/<Name zum Startzeitpunkt>`. Er wird danach nicht mehr geändert. |
| Sprint umbenennen (Name oder Ziel) | Der Name ändert sich, der Branch nicht. Aufträge und Git-Sicherung arbeiten weiter auf dem Branch vom Start. |
| Sprint abschließen | Der Branch vom Start wird nach `main` gemergt. Der Tag trägt den aktuellen Namen (siehe 2.3). |

Die Vergabe übernimmt die Datenbank selbst (Trigger `sprints_fix_branch`, Migration 13). Die API nimmt kein Branch-Feld an, auch nicht per PATCH.

### 2.2 Zwei Sprints mit gleichem Namen

Beim Anlegen und Umbenennen prüft AIdeation, ob ein anderer Sprint im Projekt denselben Branch-Namen hätte. Dann kommt eine Meldung und der Sprint wird nicht gespeichert:

> „Ein anderer Sprint dieses Projekts hat schon einen gleichwertigen Namen (gleicher Git-Branch) – bitte anders benennen.“

Der Vergleich ignoriert Groß- und Kleinschreibung, Akzente und Satzzeichen. „Sprint 5“, „sprint-5“ und „Sprint: 5“ gelten als gleich. Auch Namen, die sich erst nach dem 40. Zeichen unterscheiden, gelten als gleich.

Nur Altdaten können trotzdem zwei Sprints mit gleichem Branch haben. Die Migration hat sie einmalig auseinandergehalten: Zuerst bekommt der aktive Sprint den Branch `sprint/sprint-5`, sonst der neueste. Der andere bekommt die ersten sechs Zeichen seiner ID angehängt, zum Beispiel `sprint/sprint-5-1a2b3c`.

### 2.3 Was sich trotzdem nach dem Namen richtet

- **Tag beim Abschluss:** Er heißt `sprint-<aktueller Name>-<ID>`. Nach einer Umbenennung steht also der neue Name im Tag, der Branch aber der alte.
- **Commit-Betreff:** Die Git-Sicherung schreibt `chore(<aktueller Name>): Sprint-Stand sichern`. Die Commits einzelner Aufträge tragen den Sprint-Namen zum Zeitpunkt ihres Commits.

## 3. Bedingungen

- **Umbenennen ist in jedem Status erlaubt.** Bei abgeschlossenen Sprints löst eine Namens- oder Zieländerung weder Git-Sicherung noch Abschluss oder Merge aus.
- **Der Branch ist nicht änderbar.** Es gibt in der Oberfläche und in der API keinen Weg, den Branch eines Sprints von Hand zu setzen.
- **Fehlender Branch bei erledigten Aufträgen:** Hat ein **abgeschlossener** Sprint erledigte Aufträge, aber keinen Branch, meldet die Git-Sicherung „gescheitert“. Es wird nichts committet, getaggt oder nach `main` gemergt. Die Meldung lautet: „Sprint-Branch sprint/… fehlt, obwohl der Sprint erledigte Aufträge hat – nichts nach main übernommen.“ Bei aktiven Sprints greift diese Meldung nicht. Ein aktiver Sprint mit Start nach der Migration hat immer einen Branch.
- **Geplante Sprints haben keinen Branch.** Wer einen geplanten Sprint umbenennt, bekommt beim Start den Branch mit dem neuen Namen.
- **Die Anzeige „Branch“ im Sprint** zeigt `git_branch`, also den Branch der letzten Sicherung. Das ist nicht der Sprint-Branch aus `sprints.branch`. Nach einem Abschluss steht dort `main`, weil die letzte Sicherung auf `main` lief.

## 4. Fehlerbehebung

| Beobachtung | Ursache und was zu tun ist |
| --- | --- |
| Speichern (Anlegen oder Umbenennen) mit 409 „gleichwertigen Namen (gleicher Git-Branch)“ | Ein anderer Sprint hat schon denselben Branch-Namen. Anderen Namen wählen. |
| Git-Sicherung „gescheitert“ mit „Sprint-Branch … fehlt“ | Der Branch des Sprints ist im Repository verschwunden. Den Branch wiederherstellen, dann „Git-Sicherung“ erneut starten. Vorher wird nichts gemergt. |
| Im Sprint steht bei „Branch“ `main` | Erwartet nach dem Abschluss (siehe 3). |
| Tag heißt nach einer Umbenennung anders als der Branch | Erwartet. Der Tag nimmt den aktuellen Namen, der Branch den Namen beim Start. |
| Branch-Name endet auf `-` gefolgt von sechs Zeichen | Altdaten: Zwei Sprints hatten denselben Namen. Der Zusatz ist die Kurz-ID des Sprints. |

## 5. Grenzen dieses Kapitels

- **Altdaten, die vor dem Update umbenannt wurden:** Die Migration bildet den Branch aktiver Sprints aus dem **heutigen** Namen (`sprint/<slug>`). Sie liest nicht den Branch aus `git_branch`. Hat ein aktiver Sprint vor dem Update einen anderen Namen bekommen als seinen Branch, passt der Branch nach dem Update nicht zu ihm. Dann legt der nächste Auftrag einen neuen Branch von `main` an. Das ist nicht geprüft. Vor dem Update lohnt ein Blick in `git branch` und in die Spalte `sprints.branch`.
- **Namensprüfung:** Sie gilt für alle Sprints des Projekts, auch für abgeschlossene und abgebrochene. Ein neuer Name darf also auch dann keinen alten Branch-Namen treffen, wenn der Sprint nicht mehr läuft.
- **Tests:** Die Tests stehen in `src/runner/git-sync.test.ts` („Sprint umbenennen nach dem ersten gemergten Auftrag“, „Sprint-Abschluss ohne Sprint-Branch“) und in `src/db/sprint-branch.test.ts` (Vergabe, Migration, SQL-Slug gleich `slugify()`). Ich habe sie in dieser Sitzung nicht ausgeführt. Der Entwickler meldet sie grün über `npm test`. Die Tests in `sprint-branch.test.ts` brauchen eine lokale PostgreSQL und werden sonst übersprungen.
- **Gleicher Slug in SQL und TypeScript:** Das prüft ein Test. Die Regel steht zweimal (`sprint_branch_slug` in der Migration, `slugify()` in `git-helpers.ts`). Ändert sich eine, muss die andere mit.

## 6. Verweise

- [`workflows.md`](../workflows.md), Abschnitt „Sprint-Branch beim Start festgehalten“ und Tabelle „Git-Sicherung“
- [`benutzerhandbuch-regeln-auftraege-sprints-bugs.md`](benutzerhandbuch-regeln-auftraege-sprints-bugs.md) (Regeln für Sprints)
- [`sprint-branch-beim-start-festhalten-2026-10-25.md`](sprint-branch-beim-start-festhalten-2026-10-25.md) (Entwicklerdoku zum Fix)
