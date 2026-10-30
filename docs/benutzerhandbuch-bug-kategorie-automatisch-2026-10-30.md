# Benutzerhandbuch: Bug-Kategorie wird automatisch gesetzt

Auftrag f10a0971 („Automatische Bug-Kategorisierung beim Anlegen“). Dieses Kapitel beschreibt, welche Kategorie ein neuer Bug bekommt, unter welchen Bedingungen sie gesetzt wird und wo du sie siehst oder änderst.

> **Was sich geändert hat:** Bugs bekommen beim Anlegen eine Kategorie aus einer festen Liste. Die Regel wertet Titel, Beschreibung und, wenn vorhanden, die Quelle aus (z. B. den Dienst bei einem Produktionsfehler). Vorher setzte nur ein Teil der automatischen Stellen eine Kategorie. Bestehende Bugs ohne Kategorie wurden einmalig nach derselben Regel nachkategorisiert (Migration 19). Neu sind die Kategorien **Git-Sync**, **CI** und **Runner**.
>
> **Printscreens:** keine. Auf diesem Rechner ist kein Browser installiert, und die App lief für diesen Auftrag nicht. Die Bedingungen unten stammen aus dem Code (`src/core/bug-category.ts`, `frontend/src/app/features/bugs/bugs.component.html`, `frontend/src/app/features/bugs/bug-stats.ts`) und aus der Entwickler-Notiz. Die Tests wurden für dieses Handbuch nicht ausgeführt. Was du nachstellen kannst, steht in Abschnitt 7.

Die Regeln für Sprints und Bugs stehen auch in [`benutzerhandbuch-regeln-auftraege-sprints-bugs.md`](benutzerhandbuch-regeln-auftraege-sprints-bugs.md).

---

## 1. Die Kategorien

| Kategorie | Bezeichnung in der Oberfläche | Typischer Fall |
| --- | --- | --- |
| `security` | Sicherheit | SSRF, RCE, Schwachstelle, Pfade zu Auth oder Secrets |
| `git-sync` | Git-Sync | Worktrees, WIP-Commits, Merge-Konflikte, Pfade unter `src/runner/git-sync` |
| `ci` | CI | Fehlgeschlagene CI-Läufe, GitHub Actions, Pfade unter `.github/workflows` |
| `runner` | Runner | Runner, Worker, Heartbeat, Pfade unter `src/runner/` |
| `docs` | Dokumentation | Doku, Handbuch, README |
| `frontend` | Frontend | Oberfläche, Desktop, Handy, Browser, Angular, Pfade unter `frontend/` |
| `backend` | Backend | API, Endpoint, SQL, Pfade unter `src/api/`, `src/core/`, `src/db/`, `src/agent/` |
| `fullstack` | Fullstack | Mehrere Bereiche treffen gleichzeitig zu (z. B. Frontend und Backend) |
| `infrastructure` | Infrastruktur | Docker, Postgres, Redis, Deploy, Container |
| – | Ohne Kategorie | Keine Regel trifft zu |

Die Liste ist fest. Eine andere Kategorie lässt sich nicht erfinden. Ideen und der Visionär nutzen weiterhin die eigene Liste mit sechs Werten (Frontend, Backend, Fullstack, Infrastruktur, Dokumentation, Sicherheit). Git-Sync, CI und Runner gelten nur für Bugs.

---

## 2. Wie die Regel entscheidet

Die Regel prüft in dieser Reihenfolge. Der erste Treffer gilt:

1. **Sicherheit**
2. **Git-Sync**
3. **CI**
4. **Runner**
5. **Dokumentation**
6. **Bereiche** (Frontend, Backend, Infrastruktur): Trifft genau einer zu, gilt er. Treffen mehrere zu, gilt **Fullstack**.
7. Trifft nichts zu, bleibt der Bug **ohne Kategorie**. Die Regel rät nicht.

Das heißt: Ein Bug mit SSRF in einem Frontend-Pfad wird `security`, weil Sicherheit zuerst geprüft wird. Ein Bug, der „Worktree“ und „Handy“ nennt, wird `git-sync`.

### Wie Treffer zählen

- **Pfade** werden als Anfang eines Pfades erkannt, etwa `src/runner/git-sync/…`. Ein Pfad mitten im Text zählt, ein Pfad mitten in einem Wort nicht.
- **Stichworte** werden als ganze Wörter erkannt, ohne Unterschied zwischen Groß- und Kleinschreibung. `RCE` trifft „rce im Chat“, aber nicht „Force“. `.html` oder `.scss` zählt als Dateiendung.
- Die vollständige Tabelle steht in `src/core/bug-category.ts` (Liste `PRIORITY_RULES` für Sicherheit bis Dokumentation und `AREA_RULES` für die Bereiche).

### Beispiele

| Titel und Beschreibung | Ergebnis | Grund |
| --- | --- | --- |
| „Merge scheitert“, Beschreibung nennt `src/runner/git-sync/merge.ts` | `git-sync` | Pfad unter Git-Sync |
| „Push-Abos“, Beschreibung „SSRF in src/runner/git-sync/push.ts“ | `security` | Sicherheitsstichwort hat Vorrang vor dem Pfad |
| „Knopf verrutscht“, „Layout auf dem Handy“ | `frontend` | Stichworte „Layout“ und „Handy“ |
| „UI zeigt Fehler der API“ | `fullstack` | „UI“ (Frontend) und „API“ (Backend) treffen beide zu |
| „Absturz“, Quelle `postgres` | `infrastructure` | Quelle nennt Postgres |
| „Etwas ist kaputt“, „Bitte ansehen.“ | – (ohne Kategorie) | Kein Pfad, kein Stichwort |

### Grenzen der Regel

- Die Regel arbeitet mit Stichworten. Ein Wort wie „Worker“ im falschen Zusammenhang kann eine Kategorie setzen, die nicht passt. Ändere sie dann von Hand (Abschnitt 4).
- Die Reihenfolge ist fest. Ein Sicherheitswort gewinnt immer, auch wenn der Bug eigentlich über das Frontend spricht.
- Fehlt ein Pfad oder ein Stichwort, bleibt das Feld leer. Eine leere Kategorie ist also kein Fehler.

---

## 3. Wann die Kategorie gesetzt wird

Die Regel läuft an allen Stellen, an denen Bugs automatisch entstehen:

| Quelle | Setzt die Regel die Kategorie? |
| --- | --- |
| **Tester** (Oberflächentest und Komplettlauf) | Ja. Der angelegte Bug hat die ermittelte Kategorie. |
| **CI-Meldung** (roter CI-Lauf) | Ja. Der Titel „CI-Lauf … fehlgeschlagen“ ergibt `ci`. |
| **Agent-Fehlerbericht** (`reportAgentBug`) | Ja, sofern der Agent keine eigene Kategorie mitgibt und die Regel eine ermittelt. |
| **Problemanalyse** (`troubleshoot`) | Ja. |
| **Routinen** | Ja, wenn der Agent keine Kategorie angibt. |
| **Produktions-Rückkanal** | Ja. Sicherheit und die anderen vorrangigen Kategorien gehen vor. Infrastruktur, Frontend und Backend bleiben wie bisher (laut Entwickler-Notiz). |
| **Bug-Formular** | Nur wenn du keine Kategorie gewählt hast (siehe Abschnitt 4). |

### Bedingungen für Aufträge

- Ein Auftrag, der aus einem Bug entstanden ist, erbt die Bug-Kategorie. Das geschieht über den Datenbank-Trigger.
- Aufträge, die vor der Änderung entstanden sind, behalten ihre bisherige Kategorie. Die Regel setzt sie nicht nachträglich.
- Die Kategorie beeinflusst die Sprintzuordnung, den Auftragsstatus und das Schließen eines Bugs nicht.

---

## 4. Bug-Formular: Auswahl und Bearbeitung

### Neuen Bug anlegen

Im Feld **Kategorie** steht standardmäßig **„Automatisch (aus Pfaden und Stichworten)“**.

- **Lässt du die Auswahl stehen:** Die Regel ermittelt die Kategorie aus Titel und Beschreibung. Trifft sie nichts, bleibt der Bug ohne Kategorie.
- **Wählst du eine Kategorie:** Sie wird gespeichert, auch wenn die Regel etwas anderes ermitteln würde. Die Regel wird dann nicht angewendet.

Die Auswahl zeigt alle neun Kategorien der Bug-Liste, also auch Git-Sync, CI und Runner.

### Bestehenden Bug bearbeiten

Im Bearbeiten-Formular steht die Auswahl **„Ohne Kategorie“** vor der Liste. Speicherst du dort, übernimmt der Bug genau die Auswahl, die du getroffen hast. Die Regel läuft beim Bearbeiten nicht erneut. Du kannst eine Kategorie also bewusst leeren oder umsetzen, und sie bleibt so.

---

## 5. Bestehende Bugs: Migration 19

- Beim nächsten Start läuft die Migration **genau einmal**. Der Eintrag in `schema_migrations` verhindert eine Wiederholung.
- Sie setzt die Kategorie nur bei Bugs ohne Kategorie. Schon gesetzte Kategorien bleiben unverändert, auch wenn du sie von Hand gesetzt hast.
- Sie ändert keine Aufträge. Bestehende Aufträge behalten ihre Kategorie.
- Ein zweiter Lauf ändert keine Zeile.
- Spätere Regeländerungen wirken nur auf neu angelegte Bugs. Die Migration läuft nicht erneut.

---

## 6. Wo du die Kategorie siehst: Bug-Statistik

In der Bug-Statistik zeigt die Zeile **„Wo“** die Häufungen je Bereich. Für jede Kategorie gibt es eine Zeile mit:

- **offen**: Bugs, die nicht begraben sind,
- **begraben**: behoben, nicht behoben (kein Fix) oder abgelehnt,
- **gesamt**: die Summe aus beiden.

Bugs mit Kategorie zählen unter ihrer deutschen Bezeichnung (z. B. „Git-Sync“). Hat ein Bug keine Kategorie, nutzt die Statistik die Bereiche aus den Pfaden in der Beschreibung (z. B. Frontend, Backend). Ohne Pfad und Kategorie landet der Bug unter „Ohne Zuordnung“.

Damit siehst du Häufungen. Drei Bugs mit der Kategorie Git-Sync ergeben eine Zeile „Git-Sync“ mit der Summe aus offen und begraben.

---

## 7. Nachstellen (ohne Printscreens)

Diese Schritte kannst du selbst prüfen:

1. **Bug mit Pfad anlegen:** Titel „Merge scheitert“, Beschreibung mit `src/runner/git-sync/merge.ts`, Kategorie auf „Automatisch“. Der Bug sollte in der Tabelle die Kategorie **Git-Sync** zeigen.
2. **Sicherheitsfall anlegen:** Beschreibung „SSRF in src/runner/git-sync/push.ts“. Erwartet: **Sicherheit**.
3. **Bug ohne Treffer anlegen:** Titel „Etwas ist kaputt“, Beschreibung „Bitte ansehen.“. Erwartet: keine Kategorie („Ohne Kategorie“).
4. **Manuelle Wahl prüfen:** Einen Bug mit Beschreibung „Handy-Layout“ und der Kategorie **Backend** anlegen. Erwartet: **Backend**, die Regel überschreibt die Wahl nicht.
5. **Statistik prüfen:** Drei Bugs mit Kategorie Git-Sync anlegen. In der Zeile „Wo“ sollte „Git-Sync“ mit der Summe 3 stehen.

Für Printscreens nimm bitte auf: das Bug-Formular mit geöffneter Kategorie-Auswahl, die Bug-Tabelle mit der Spalte Kategorie und die Zeile „Wo“ der Bug-Statistik.

---

## 8. Fehlerbehebung

- **Der Bug hat keine Kategorie.** Prüfe, ob Titel oder Beschreibung einen Pfad oder ein Stichwort aus Abschnitt 2 enthalten. Trifft nichts zu, bleibt das Feld leer. Setze die Kategorie dann von Hand im Bearbeiten-Formular.
- **Die Kategorie ist falsch.** Häufig greift ein Stichwort, das in einem anderen Zusammenhang steht, oder eine höhere Regel (z. B. Sicherheit) gewinnt. Setze die Kategorie von Hand. Die Regel ändert sie nicht wieder.
- **Ein alter Bug hat keine Kategorie, obwohl er einen Pfad nennt.** Die Migration lief vermutlich schon, oder die Kategorie wurde früher von Hand geleert. Die Migration überschreibt nichts, was bereits geleert ist. Setze die Kategorie dann von Hand.
- **Die Kategorie fehlt im Auftrag, obwohl der Bug eine hat.** Aufträge, die vor der Änderung entstanden sind, bekommen keine nachträgliche Kategorie.

---

## 9. Für Entwickler

- Die Regeln stehen nur in `src/core/bug-category.ts` (`PRIORITY_RULES`, `AREA_RULES`). Die Funktion `categorizeBug({ title, description, source })` liefert eine Kategorie oder `null`.
- `bugCategorySql` erzeugt aus denselben Regeln das SQL für Migration 19. Es gibt keine zweite Regel.
- Die erlaubten Werte stehen in `BUG_CATEGORY_VALUES`. Die Constraints `bugs_category_check` und `development_items_category_check` müssen **gemeinsam** geändert werden, weil der Trigger `development_items_inherit_category` die Kategorie in den Auftrag überträgt.
- Die Liste der Bug-Kategorien für die Oberfläche steht in `frontend/src/app/shared/labels.ts` (`BUG_CATEGORIES`). Die Bezeichnungen stehen in `CATEGORY_LABELS` derselben Datei.
- Neue Stichworte oder Pfade: in der Tabelle eintragen und einen Fall in `src/core/bug-category.test.ts` ergänzen.
- Tests: `src/core/bug-category.test.ts` und `src/runner/git-sync.test.ts`. Bitte über `npm test` starten.

---

## Offen

- **Keine Printscreens.** Die App lief nicht, und auf diesem Rechner ist kein Browser installiert. Abschnitt 7 beschreibt das Nachstellen.
- **Tests nicht ausgeführt.** Für dieses Handbuch wurden keine Tests gestartet. Der Tester muss den Schema-Test über alle Constraint-Fassungen (inklusive Quelle `github`), den zweiten Lauf der Migration (0 Zeilen) und die Oberflächen- und E2E-Tests für die Kategorie-Auswahl prüfen.
- **Auftragsformular:** Die geerbten Kategorien Git-Sync, CI und Runner werden im Auftrag angezeigt, aber nicht zur Auswahl angeboten (Folgearbeit).
- **GitHub-Import** (`src/runner/github-sync.ts`) kategorisiert noch nicht. Folgeauftrag.
