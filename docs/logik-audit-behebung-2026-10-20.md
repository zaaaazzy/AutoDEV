# Logik-Audit: Behebung – 20.10.2026

Grundlage: `AIdeation/logikprobleme-2026-10-20.md` und die daraus angelegten Aufträge. Behoben wurden die 45 Aufträge im Backlog; die 8 kritischen Punkte in Sprint 8 bearbeiten die AIdeation-Agents selbst und sind hier nicht enthalten.

Branch `fix/logik-audit` (Basis `main` 34bd5a0), zusammengeführt aus `fix/audit-git`, `fix/audit-runner`, `fix/audit-agent`, `fix/audit-api` und `fix/audit-frontend`. 41 Commits, jeder nennt im Text `Auftrag: <uuid>`.

## Prüfungen

| Prüfung                                   | Ergebnis                                                   |
| ----------------------------------------- | ---------------------------------------------------------- |
| `npm run typecheck`                       | ok                                                         |
| `npm run lint`                            | 0 Fehler, 482 Warnungen (`no-non-null-assertion`)          |
| `npm run format:check`                    | ok                                                         |
| `npm run build:ui`                        | ok, bekannte Warnung: Start-Bundle 1,00 MB (Grenze 1,1 MB) |
| `tsx --test` (Backend und Frontend-Specs) | 714/714 bestanden                                          |

## Ergebnis je Bereich

**Git / Review (6):** Review-DB-Kopie scheitert bei fehlerhaftem `pg_dump`; Sprint-Auftrag zweigt nur vom Sprint-Branch ab; nach verworfenem Merge wird nur gemeldet, was wirklich gesichert ist (Patch-Pfad); im PR-Modus wird nach dem Merge live geschaltet (`src/runner/go-live.ts`); „Live geschaltet“ nur bei erfolgreichem Deploy. Bereits vorher behoben: rotes Test-Gate setzt `main` zurück.

**Runner (8):** Abgebrochene Läufe erzeugen keinen Bug-Bericht; Fortsetzung nach Nachbesserung richtig zugeordnet; ausgewählte Aufträge werden vor dem Start erneut geprüft, ein Fehler stoppt nicht mehr den ganzen Zyklus; Budget wird vor jedem Auftrag geprüft; hängende Aufträge `in_progress` werden erkannt und blockiert (`recoverStuckItems`); „Vor dem Sprint“ wird bei Fehlschlag wiederholt (höchstens 3 Mal); gescheiterter Neustart meldet sich nur einmal, `docs/workflows.md` entspricht dem Code. Bereits vorher behoben: Erkennung des Worktrees `<Projekt>/agent`.

**Agent-Rechte (10):** Bei mehreren Urteilszeilen zählt die letzte bzw. die strengere; `StringDecoder` je Stream; API-Schlüssel werden maskiert, `--settings`/`--add-dir` im Lesemodus entfernt; Chat-Verlauf endet bei der übernommenen Nachricht; Cache-Tokens zählen zum Token-Verbrauch; gesperrte Namen auch am Symlink-Ziel; gemeinsame npm-Optionsprüfung für Wächter und Ollama (inkl. Abkürzungen, `-C`, `-g`); `git diff` nur mit Pfaden im Projekt; breite eigene Befehlsgruppen geben gesperrte Unterbefehle nicht frei. Modell-Routing: Verhalten ist gewollt, nur Doku und Kommentare angepasst.

**API (9):** `POST /projects` liefert 409 bei vergebener ID; Sprint-Statuswechsel nach Übergangstabelle und atomar; aktive Sprints und Sprints im Review nicht löschbar; veraltete Doku-Revisionen werden mit 409 abgelehnt; Ideen während des Autors und nach Annahme nicht per PATCH änderbar; Ingest zählt das Projektlimit erst nach gültigem Token; `/review-slots` für die Rolle „run“; Chat-Stream endet nach Logout, Deaktivierung oder Rechteentzug; Budget-Tag und Burndown in Ortszeit (`DEV_LOG_TIMEZONE`, Standard `Europe/Zurich`).

**Frontend (12 + Zeitzone):** Ladefehler einzelner Bereiche löschen keine Daten mehr; Markdown-Listen mit Fortsetzungszeilen; Datumsanzeige in Ortszeit; Dashboard und Ideenseite zählen gleich; Status „approval“ und neueste Sprints im Dashboard; kein Duplikat bei gescheitertem Bild-Upload; Fehlerbehandlung in den Systemagent-Einstellungen; Pflichtkommentar beim Zurückweisen; ein gemeinsamer Poll für Freigaben; keine zweite Chat-Instanz auf dem Dashboard; „Verlauf leeren“ nur nach Rückfrage.

## Verhaltensänderungen, die man kennen sollte

- **Token-Budgets greifen früher:** Cache-Tokens zählen jetzt mit. Bestehende `max_tokens`-Grenzen wurden mit zu niedrigen Werten eingestellt und sollten geprüft werden.
- **Strengere Befehlsrechte:** Eigene Regeln wie `Bash(git:*)` oder `Bash(npm:*)` werden abgelehnt; bestehende breite Regeln in der Datenbank bleiben stehen, der Wächter fängt die gesperrten Unterbefehle ab. `npm install … --ignore-scripts` muss die Option direkt nach `install` haben.
- **Neue 409-Antworten:** Löschen aktiver Sprints, Abschliessen mit laufenden Aufträgen, Freigabe veralteter Revisionen (auch ältere offene Revisionen ohne gespeicherten Ausgangsstand). Die Oberfläche zeigt die Meldung, blendet die Knöpfe aber noch nicht aus.
- **Sprint „Wieder öffnen“** (completed → active) bleibt erlaubt, weil die Oberfläche es anbietet.
- **Review-DB-Kopie:** `ON_ERROR_STOP=1` lässt auch harmlose SQL-Fehler beim Einspielen scheitern; an einem echten Projekt prüfen.
- **Hängende Aufträge** werden blockiert statt neu eingeplant; „Erneut versuchen“ startet sie wieder.

## Offen

- `DELETE /projects/:slug/chat` löscht weiterhin auch wartende Anfragen (jetzt nach Rückfrage).
- Weitere UTC-Stellen ausserhalb der Aufträge: `CURRENT_DATE` in `sprint-planning.ts`, Trigger `sprint_default_start_date`, `created_at::date` in `usage.ts`.
- „Vor dem Sprint“: Fehlversuche werden nur im Speicher gezählt (nach einem Worker-Neustart wieder bis zu 3).
- Merge mit Sprint 8: kleine Konflikte erwartet in `src/runner/git-sync.ts` (`enterOrderBranch`), `src/agent/agent-guard.ts`, `src/api/sprints.ts` und `src/runner/runner-steps.ts`/`autofix.ts`.
