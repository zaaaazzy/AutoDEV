# Bug-Kategorien mit Vorschlag, Filter und Statistik

Auftrag ff127e1a-6b7d-4358-a136-f9be1f6ca313. Technische Beschreibung: `docs/laufzeit.md`, Abschnitt „Bug-Kategorien (Migration 26)“; Datenmodell: `docs/erm.md`.

## Aufträge

### Ziel
Jeder Bug kann eine feste Bug-Kategorie aus acht Werten tragen (`security`, `git-sync`, `ci`, `ui`, `api`, `agent-guard`, `budget`, `docs`). Sie wird beim Anlegen vergeben oder vom lokalen Ollama-Modell vorgeschlagen und von Menschen bestätigt. Die Bugs-Seite filtert danach, die Statistik zeigt Kategorie × Sprint, und die Retrospektive-Eingabe liefert dieselben Zahlen.

### Umsetzung
- **Migration:** Version **26**, nicht 20 wie im Auftrag geplant (20–25 waren belegt). Neue Spalten `bug_category`, `bug_category_suggested`, `bug_category_state` mit CHECK auf genau die acht Werte (`src/core/bug-category-values.ts` ist die einzige Quelle) und Index. `bugs.category` und der Trigger `development_items_inherit_category` bleiben unverändert (Annahme des Auftrags: `bug_category` steht neben `category`).
- **Zustand:** leer, `suggested` (nur Vorschlag) oder `confirmed` (`bug_category` gesetzt). Gezählt wird nur die bestätigte Kategorie.
- **Anlegen:** `POST /projects/:slug/bugs` (`bugCategory`) und `reportAgentBug` setzen eine gültige Kategorie sofort als bestätigt. `src/runner/autofix.ts` gibt bei einer Sperre des Agent-Wächters `agent-guard` mit. Ohne Kategorie schlägt das Modell im Hintergrund vor; das blockiert und wiederholt nichts.
- **Klassifikator** (`src/agent/bug-category.ts`, `src/agent/bug-classifier.ts`): Rolle `bug_category`, Modell über `DEV_LOG_OLLAMA_MODEL_BUG_CATEGORY`. Reine Textanfrage ohne Werkzeuge. Der Bugtext steht nur als JSON im Block `<bug_daten>` (spitze Klammern maskiert), die Regeln stehen in der System-Nachricht. Akzeptiert wird nur eine Antwort, die genau einem der acht Werte entspricht; alles andere wird verworfen. Limit-, Kosten- und Verbindungsmeldungen als Bugtext bekommen keinen Vorschlag.
- **Altbestand:** `POST /projects/:slug/bugs/categorize-backlog` (Recht `plan`) erzeugt nacheinander je Bug ohne Kategorie und ohne Vorschlag einen Vorschlag und ändert `bug_category` nie. Ein Fehler bei einem Bug stoppt den Lauf nicht; je Prozess läuft höchstens ein Lauf (zweiter Aufruf: 409). `GET` zeigt den Stand, `DELETE` bricht ab.
- **Bestätigen** (Recht `plan`, serverseitig geprüft): `POST /bugs/:id/category/confirm` (ohne Angabe gilt der Vorschlag, mit `category` eine Korrektur), `POST /projects/:slug/bugs/category/confirm` mit `ids` für mehrere, außerdem `PATCH /bugs/:id` mit `bugCategory`.
- **Statistik:** `collectStats` (`src/api/stats.ts`) liefert `bugsByCategory` und `bugsByCategorySprint` (offen und begraben getrennt, `sprintId` null = „Kein Sprint“). `retrospectiveInput` nutzt dieselbe Zählung (`bugCategoryStats`).
- **Oberfläche:** Bugs-Seite mit Spalte „Kategorie“ samt Filter (acht Werte, „Vorschlag offen“, „Ohne Kategorie“); die bisherige Spalte heißt jetzt „Bereich“. Auswahl im Anlegeformular, Bestätigen in der Zeile, im aufgeklappten Bug oder gesammelt, Knopf „Altbestand kategorisieren“. Knöpfe nur mit `auth.can('plan')`. Die Bug-Statistik „Nach Kategorie“ zählt jetzt die Bug-Kategorie; neu ist die Tabelle „Kategorie × Sprint“ (`bug-category-matrix.component.ts`, auch auf der Statistik-Seite).

### Geänderte Dateien
- Neu: `src/core/bug-category-values.ts`, `src/agent/bug-category.ts` (+ `.test.ts`), `src/agent/bug-classifier.ts`, `frontend/src/app/features/bugs/bug-category-matrix.component.ts`
- Backend: `src/db/migrations.ts`, `src/api/bugs.ts`, `src/api/stats.ts`, `src/runner/autofix.ts`, `src/core/test-bugs.ts`
- Frontend: `frontend/src/app/core/models.ts`, `shared/labels.ts`, `features/bugs/` (`bugs.component.ts/.html`, `bug-form.ts`, `bug-stats.ts`), `features/stats/` (`stats.component.ts/.html`), `frontend/src/styles/16-bugs.css`
- Tests: `src/api/bugs.test.ts`, `src/api/stats.test.ts`, `src/db/migrations.test.ts`, `src/agent/ollama-client.test.ts`, `src/runner/autofix.test.ts`, `src/core/test-bugs.test.ts`, `bug-form.spec.ts`, `bug-stats.spec.ts`, `e2e/app.spec.ts`, `e2e/full-ui.check.ts`
- Doku: `docs/laufzeit.md`, `docs/erm.md`, diese Datei

### Worauf zu achten ist
- Die Migrationsnummer ist 26. Worker nach dem Deployment neu starten.
- Die Werte im CHECK müssen den Werten im Code entsprechen (`bug-category-values.ts`); ein Test prüft das.
- Der Altbestandslauf braucht ein erreichbares Ollama (Minuten pro Antwort möglich); ohne Ollama entstehen keine Vorschläge, aber auch keine Fehler am Bug.
- Die Zahlen der Bug-Statistik „Nach Kategorie“ ändern sich bewusst (vorher Bereich, jetzt Bug-Kategorie).
- Unabhängig davon gibt es das frühere Feature „Bugs automatisch nach Bereich kategorisieren“ (`docs/bug-kategorien.md`) für das Feld `category`; beide Felder bleiben getrennt.
- Der Retrospektive-Agent selbst ist nicht Teil des Auftrags.
- Offene Entscheidung für den Auftraggeber: `bug_category` bleibt neben `category` (Annahme). Ein Ersetzen würde den Vererbungstrigger ändern.

### Teststand
Der Tester-Schritt (after_task) ist **fehlgeschlagen**: Im gemeldeten Lauf (u. a. `src/runner/autofix.test.ts`, 95 Tests) bestanden 93, 2 schlugen fehl. Aus dem Auszug ist nicht erkennbar, welche beiden Tests es sind. Der Dokumentierer konnte sie hier nicht erneut ausführen (Befehle brauchten eine Freigabe), also ist die Ursache nicht geklärt und kein grüner Lauf belegt. Der Entwickler muss die fehlgeschlagenen Tests aus dem Testprotokoll ermitteln und beheben (Aufruf ohne Abdeckungs-Flags: `npx --no-install tsx --test <Datei>`). Danach sind Typprüfung, Unit-Tests, Frontend-Specs und `e2e/full-ui.check.ts` erneut zu prüfen.

## Sprint

| Auftrag | Zustand | Details |
|---|---|---|
| ff127e1a Bug-Kategorien mit Vorschlag, Filter und Statistik | umgesetzt, Tester-Lauf mit 2 fehlgeschlagenen Tests, Nachbesserung offen | Migration 26, Klassifikator, Altbestandslauf, Bestätigen, Filter, Tabelle Kategorie × Sprint, Retrospektive-Eingabe |

## Anfrage/TODO
- Entwickler: die 2 fehlgeschlagenen Tests aus dem Tester-Lauf finden und beheben.
- Tester: danach Tests der genannten Dateien und den Oberflächentest ausführen; prüfen, dass die Summe der Tabelle Kategorie × Sprint der Zahl aller Bugs entspricht.
- Auftraggeber: Annahme `bug_category` neben `category` bestätigen.
- Nach dem Deployment: Worker neu starten, danach bei Bedarf „Altbestand kategorisieren“ (die 61 Bestandsbugs) ausführen und die Vorschläge prüfen.
