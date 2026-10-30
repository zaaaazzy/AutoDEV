# Automatische Bug-Kategorie beim Anlegen (30.10.2026)

Auftrag f10a0971 „Automatische Bug-Kategorisierung beim Anlegen“.

## Was sich ändert

- **Regel:** `src/core/bug-category.ts` ordnet einen Bug rein regelbasiert (ohne KI) einer festen Liste zu:
  `security`, `git-sync`, `ci`, `runner`, `docs`, `frontend`, `backend`, `fullstack`, `infrastructure`.
  Eingabe sind Titel, Beschreibung und optional eine Quelle (z. B. Dienst bei Betriebsfehlern).
  - Prüfreihenfolge: Sicherheit → Git-Sync → CI → Runner → Dokumentation → Bereiche (Frontend, Backend,
    Infrastruktur). Mehrere Bereiche ergeben Fullstack. Ohne Treffer bleibt die Kategorie leer.
  - Je Kategorie eine Tabelle mit Pfadanfängen (z. B. `src/runner/git-sync`) und Stichworten (ganze Wörter, ohne
    Gross-/Kleinschreibung, z. B. `SSRF`, `RCE`, `Worktree`, `WIP-Commit`, `Handy`). `api` aus der Idee zählt zu Backend.
  - Stichworte und Pfade sind einfache Textvergleiche mit Wortgrenzen, keine frei eingegebenen regulären Ausdrücke.
- **Wo die Regel läuft:** Tester (Oberflächen-/Einzeltests und Komplettlauf, `fileBugs`), CI-Meldung (roter CI-Lauf im
  Pull Request → `ci`), Agent-Fehlerbericht (`reportAgentBug`), Problemanalyse (`troubleshoot`), Routinen (wenn der
  Agent keine Kategorie angibt) und Bug-Formular (nur wenn keine Kategorie gewählt ist; die Auswahl heisst jetzt
  „Automatisch (aus Pfaden und Stichworten)“).
- **Produktions-Rückkanal:** `categoryFor` bleibt für Infrastruktur, Frontend und Backend unverändert; nur die
  vorrangigen Kategorien (z. B. Sicherheit) gehen vor (`bugCategoryFor`). Health-Ausfälle bleiben Infrastruktur.
- **Datenbank – Migration 19 `bug-kategorie-automatisch`:**
  - Die Constraints `bugs_category_check` und `development_items_category_check` erlauben die neue Liste. Beide werden
    zusammen geändert, weil der Trigger `development_items_inherit_category` die Bug-Kategorie in den Auftrag übernimmt.
  - Ideen bleiben bei der bisherigen Liste.
  - Bisherige Bugs mit leerer Kategorie werden einmalig nach derselben Regel zugeordnet. Das SQL wird aus der
    Regeltabelle erzeugt. Gesetzte Kategorien und bestehende Aufträge bleiben unverändert.
  - `schema.ts` (Basis-Schritt) ist nicht angefasst.
- **Oberfläche:** Bug-Formular und Bug-Bearbeitung bieten die Bug-Liste an (`BUG_CATEGORIES`). Bezeichnungen „Git-Sync“,
  „CI“, „Runner“ stehen in `labels.ts`, Farben in `04-components.css`. Die Bug-Statistik (Zeile „Wo“) zeigt die neuen
  Kategorien ohne Logikänderung.

## Auftrag

**f10a0971-f92a-49d3-a2ec-206b8a7602cd – Automatische Bug-Kategorisierung beim Anlegen** (Entwickler: bestanden,
Dokumentierer: dieser Eintrag). Geschätzt 0,3 h und 3,0 Mio. Tokens.

Umgesetzt: regelbasierter Kategorisierer, Einhängen an allen automatischen Bug-Anlagen, Bug-Formular mit
„Automatisch“-Auswahl, Constraints für `bugs` und `development_items`, einmalige Nachkategorisierung per Migration 19,
Bezeichnungen und Farben für die neuen Werte.

Geänderte Dateien:

- Neu: `src/core/bug-category.ts`, `src/core/bug-category.test.ts`
- Backend: `src/core/validation.ts` (`BUG_CATEGORIES`), `src/core/test-bugs.ts`, `src/api/bugs.ts`,
  `src/agent/troubleshoot.ts`, `src/agent/routine.ts`, `src/runner/git-sync/sprint-reviews.ts`,
  `src/runner/production-events.ts`, `src/runner/git-sync.test.ts`, `src/db/migrations.ts`
- Frontend: `core/models.ts`, `shared/labels.ts`, `shared/data-table/columns.ts`, `features/bugs/bugs.component.ts`,
  `features/bugs/bugs.component.html`, `features/bugs/bug-stats.spec.ts`, `styles/04-components.css`
- Doku: diese Datei

Worauf zu achten ist:

- Bestehende Migrationsschritte nicht ändern; Regeländerungen wirken nur auf neue Bugs.
- Die Constraints erlauben weiter alle bisherigen Werte (auch Quelle `github`); beide Constraints immer gemeinsam ändern.
- Eine gewählte Kategorie im Formular wird nie überschrieben; Sprintzuordnung, Auftragsstatus und Bug-Schliessung
  bleiben unberührt.
- Prettier lief beim Entwickler nicht: bei Meldungen der Formatprüfung `npm run format` ausführen.
- Tests über `npm test` bzw. `npm run …` starten; kein `npx tsx --test` und keine Abdeckungs-Flags.
- `src/api/bugs.ts` wird auch vom Bug-Wächter-Auftrag geändert: bei Merge auf Konflikte achten.

## Sprint

| Auftrag | Zustand | Details |
| --- | --- | --- |
| f10a0971 Automatische Bug-Kategorisierung | Entwicklung bestanden, Dokumentation fertig; Abnahme durch Tester offen | Neu: Regel-Datei samt Test; Migration 19; 6 Einhängepunkte; Frontend-Auswahl und Labels |

## Anfrage/TODO

- Folgeauftrag: GitHub-Import (`src/runner/github-sync.ts:77`) kategorisieren.
- Offen: Auftragsformular/-detail bietet geerbte Kategorien `git-sync`, `ci`, `runner` nicht zur Auswahl an.
- Offen: Retrospektive-Auswertung existiert nur als Idee; Auswertung bis dahin über die Bug-Statistik.
- Tester: Schema-Test über alle Constraint-Fassungen, Migrationstest (zweiter Lauf ändert 0 Zeilen) und
  `full-ui.check.ts`/E2E für die geänderte Auswahl prüfen.

## Technik

- `categorizeBug({ title, description, source })` → Kategorie oder `null`; reine Funktion, Regeln in `PRIORITY_RULES`
  (Sicherheit, Git-Sync, CI, Runner, Dokumentation) und `AREA_RULES` (Frontend, Backend, Infrastruktur; mehrere → Fullstack).
- Migration 19 erzeugt ihr SQL aus der Regeltabelle und setzt nur Bugs mit `category IS NULL`; `schema_migrations`
  garantiert den Einmal-Lauf.
- Der Trigger `development_items_inherit_category` bleibt unverändert; bereits entstandene Aufträge behalten ihre Kategorie.

## Bewusst nicht enthalten

- GitHub-Import (`src/runner/github-sync.ts`): Folgeauftrag.
- Auftragsformular und Auftragsdetail bieten weiter nur die Ideen-Liste an. Ein aus einem Bug geerbtes `git-sync`,
  `ci` oder `runner` wird dort angezeigt, aber nicht zur Auswahl angeboten.
- Retrospektive: Im Code gibt es keine Auswertung, nur die Idee `docs/ideen/08-retrospektive-lernende-leitlinien.md`.
  Ausgewertet wird über die bestehende Bug-Statistik.

## Regeln pflegen

Neue Stichworte oder Pfade in `PRIORITY_RULES` bzw. `AREA_RULES` eintragen und einen Fall in
`src/core/bug-category.test.ts` (`SAMPLES`) ergänzen. Der Datenbanktest prüft, dass SQL und TypeScript dasselbe
ergeben. Regeländerungen wirken nur auf neue Bugs, Migration 19 läuft nicht erneut.
