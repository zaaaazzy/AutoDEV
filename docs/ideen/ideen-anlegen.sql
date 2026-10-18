-- Ideen für Dev Log anlegen: neue Idee „Visionär anschließen“ plus die Vorschläge 02 und 04–08 aus diesem Ordner.
-- Aufruf aus dem Projektordner (Projekt-Slug anpassen):
--   docker exec -i devlog-db-1 sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -v slug=dev-log' < docs/ideen/ideen-anlegen.sql
-- Ideen mit gleichem Titel im Projekt werden übersprungen; das Skript kann also mehrfach laufen.

BEGIN;

SELECT slug, name FROM projects WHERE slug = :'slug';

INSERT INTO ideation_items (project_slug, title, description, status, priority, category, benefit, cost, effort_hours, source)
SELECT :'slug', i.title, i.description, 'idea', i.priority, i.category, i.benefit, i.cost, i.effort, 'human'
  FROM (VALUES
    ($t$Visionär in Aktionen und Ideation anschließen$t$,
     $d$Der Visionär-Kern ist vorhanden (`src/agent/visionary.ts`: Kontext sammeln, Prompt, `@@IDEA`-Auswertung, Dubletten-Schutz, Ablage mit `source = 'visionary'`, `requestVisionaryRun`/`processVisionaryRun`; Tabelle `visionary_runs`; Rolle nur lesend), wird aber nirgends aufgerufen – er stammt aus dem Zwischenstand des fehlgeschlagenen Auftrags 38a2f44e.

Fehlt:
- Route `POST /api/projects/:slug/ideation/visionary` (Rolle `plan` in `roles.ts`) plus Status/Abbrechen
- Aufruf von `processVisionaryRun` im Worker (`runner-cli.ts`)
- Knopf „Ideen vorschlagen lassen“ in Ideation mit Fortschritt und Abbrechen
- Standard-Aktion „Ideen vorschlagen“ für den Visionär (Aktionen-Menü und Quick Actions)
- Einstellung „max. Ideen pro Lauf“ (`visionary_max_ideas`)
- Filter und Badge „Herkunft: Visionär“
- Tests

Grundlage: `docs/ideen/01-visionaer-agent.md`.$d$,
     'high', 'fullstack', 8, 3, 8::double precision),
    ($t$Zeitgesteuerte Routinen: Agent-Aufgaben nach Zeitplan ausführen und Ergebnisse automatisch weiterleiten$t$,
     $d$Agent-Aufgaben bekommen einen optionalen Zeitplan (täglich/wöchentlich/Cron-Ausdruck, Zeitzone Europe/Zurich) und ein Ziel für das Ergebnis: nur Chat, Push, neuer Bug, neue Idee oder neuer Auftrag im Backlog. Der Worker prüft fällige Routinen und führt sie wie heute per Klick über den Assistenten aus. Mitgelieferte Vorlagen: „Nächtlicher Sicherheits-Check“ (`npm audit`, `npm outdated`), „Wöchentlicher Doku-Abgleich“ (README/Docs gegen Code), „Tote Dateien und TODOs finden“, „Testabdeckung unter 75 % melden“. Jede Ausführung wird protokolliert (letzter Lauf, Ergebnis, Dauer, Tokens), Fehlschläge melden sich per Push.

Grundlage: `docs/ideen/02-zeitgesteuerte-routinen.md`.$d$,
     'high', 'fullstack', 8, 3, 12),
    ($t$Budget-Wächter und Modell-Routing: Kostenlimits je Projekt/Sprint und passendes Modell je Auftrag$t$,
     $d$Pro Projekt lassen sich Limits für Tokens und Kosten (USD/CHF) je Tag, je Sprint und je Auftrag festlegen. Der Worker prüft vor jedem Agent-Schritt das verbleibende Budget: Bei 80 % kommt eine Push-Warnung, bei 100 % pausieren neue Läufe (laufende werden sauber beendet) mit Hinweis „Budget erreicht“ als „Aktion notwendig“. Zusätzlich wählt ein Modell-Routing das Modell je Auftrag: einfache Aufträge (Doku, kleine Frontend-Änderungen, niedrige Schätzung) laufen lokal über Ollama, komplexe oder zweimal gescheiterte Aufträge eskalieren auf das stärkere Modell (z. B. Claude-CLI). Die Statistik zeigt Verbrauch gegen Budget und die Ersparnis durch Routing.

Grundlage: `docs/ideen/04-budget-und-modell-routing.md`.$d$,
     'medium', 'backend', 8, 5, 20),
    ($t$Produktions-Rückkanal: Fehler der betreuten Anwendung automatisch erkennen, bündeln und als Bug erfassen$t$,
     $d$Dev Log überwacht nicht nur sich selbst (Wächter), sondern auch die betreuten Anwendungen. Drei Quellen: (1) Health-URL des Projekts wird regelmäßig abgefragt, (2) nach jedem Deploy und periodisch werden `docker compose logs --since` nach Fehlermustern (Stacktraces, `ERROR`, HTTP 5xx) durchsucht, (3) ein Fehler-Endpunkt `POST /api/ingest/<projekt>/<token>` nimmt Frontend- und Backend-Fehler direkt aus der Anwendung an (kleines Snippet in der Doku). Gleiche Fehler werden über einen Fingerabdruck (Meldung + oberster Stack-Frame) gebündelt und zählen hoch statt neue Bugs zu erzeugen. Neue Fehler werden zu Bugs mit Quelle „Betrieb“, Schwere nach Häufigkeit; mit aktivem Auto-Bugfix entsteht direkt ein Bug-Auftrag. Fällt ein Fehler direkt nach einem Deploy neu auf, wird der letzte Sprint/Auftrag als Verdacht verlinkt.

Grundlage: `docs/ideen/05-produktions-rueckkanal.md`.$d$,
     'high', 'fullstack', 9, 5, 22),
    ($t$Visuelle Abnahme: Screenshots vor/nach Frontend-Aufträgen (Desktop und Handy) automatisch erstellen und vergleichen$t$,
     $d$Bei Aufträgen der Kategorie `frontend`/`fullstack` erstellt ein neuer Schritt nach dem Tester Screenshots der betroffenen Seiten in zwei Größen (Desktop, Handy) – einmal vom Stand vor dem Auftrag (Sprint-Branch-Basis) und einmal danach. Die Bilder hängen am Auftrag, ein Pixel-Vergleich markiert geänderte Bereiche. Zusätzlich laufen automatische Layout-Prüfungen: horizontales Scrollen auf dem Handy (wie `?layoutcheck`), abgeschnittene Texte, Konsolenfehler, fehlende Bilder. Ein Bild-fähiges Modell (optional) beurteilt die Screenshots gegen die Akzeptanzkriterien. Viele heutige „manuelle Abnahmepunkte“ („auf dem Handy prüfen“) werden damit automatisch prüfbar; der Mensch sieht in der Auftragsansicht vorher/nachher nebeneinander und gibt per Klick frei.

Grundlage: `docs/ideen/06-visuelle-abnahme.md`.$d$,
     'medium', 'fullstack', 7, 5, 18),
    ($t$GitHub-Brücke: Issues als Ideen/Bugs übernehmen und Sprint-Abschluss als Pull Request mit CI-Status$t$,
     $d$Dev Log verbindet sich (per `gh`-CLI-Anmeldung des Workers oder fein eingeschränktem Token) mit dem GitHub-Repository des Projekts. Eingang: Issues mit Label `idea` werden zu Ideen, mit Label `bug` zu Bugs (mit Link zurück); Status-Änderungen in Dev Log werden als Kommentar ins Issue geschrieben und beim Erledigen wird das Issue geschlossen. Ausgang: Statt beim Sprint-Abschluss direkt nach `main` zu mergen, kann Dev Log einen Pull Request vom Sprint-Branch öffnen (Beschreibung = Sprintbericht), den CI-Status der Checks am Sprint anzeigen und erst nach grüner CI (und optional Freigabe eines Menschen) mergen. Rote CI erzeugt einen Bug mit dem Log-Auszug.

Grundlage: `docs/ideen/07-github-bruecke.md`.$d$,
     'medium', 'backend', 7, 4, 18),
    ($t$Retrospektive-Agent: nach jedem Sprint aus Fehlern lernen und Änderungen an Leitlinien, DoR/DoD und Agent-Anweisungen vorschlagen$t$,
     $d$Nach jedem Sprint-Abschluss analysiert ein Retrospektive-Agent (nur lesend) den Sprint: blockierte Aufträge und ihre Ursachen, Bugs samt Fix-Notizen, Review-Befunde („Änderungen nötig“), Abweichungen Schätzung vs. Ist, wiederholte „Aktion notwendig“-Fälle und Schleifen-Abbrüche. Ergebnis ist ein Abschnitt „Retrospektive“ im Sprintbericht (gut gelaufen / schlecht gelaufen / Muster) und konkrete Änderungsvorschläge an den Projekt-Leitlinien, an Definition of Ready/Done und an den Anweisungen einzelner Agents. Die Vorschläge laufen als Änderung zur Prüfung durch die bestehende Redaktion: Ein Mensch nimmt sie an oder lehnt sie ab. Angenommene Regeln wirken ab dem nächsten Auftrag – die Agents lernen dauerhaft aus wiederkehrenden Fehlern.

Grundlage: `docs/ideen/08-retrospektive-lernende-leitlinien.md`.$d$,
     'medium', 'backend', 8, 3, 12)
  ) AS i(title, description, priority, category, benefit, cost, effort)
 WHERE EXISTS (SELECT 1 FROM projects WHERE slug = :'slug')
   AND NOT EXISTS (
     SELECT 1 FROM ideation_items x WHERE x.project_slug = :'slug' AND lower(x.title) = lower(i.title)
   )
RETURNING left(title, 70) AS angelegt, priority, category;

COMMIT;
