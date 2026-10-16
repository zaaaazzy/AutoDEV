# Workflows im Dev Log

Ergänzt [agents-und-rechte.md](./agents-und-rechte.md) (Worker, Trigger, Rechte) um den **logischen Ablauf** der Workflows.

## 1. Überblick

```
Idee ──schätzen──► Idee ──ausarbeiten (Auftragsautor)──► Auftrag (Backlog)
                                                              │ Sprint zuordnen + Sprint starten
                                                              ▼
                                              Auftrag „Geplant“ (automatisch im aktiven Sprint)
                                                              │ Worker-Zyklus (30 s)
                                                              ▼
                      pre_task → while_task → after_task (Agents des Projekts)
                         │                                   │
                    Fehler: Auftrag „Blockiert“          Erfolg: Auftrag „Erledigt“
                         │                                   │
                  Bug-Bericht + Fix-Auftrag             Commit im Projektordner
                         │ Fix erfolgreich                     │
                  Ursprungsauftrag läuft erneut         Sprint abschließen ─► Sammel-Commit, Tag, Push
```

## 2. Ideen → Aufträge

1. **Schätzung** (`estimateIdeas`): Ideen ohne Schätzung erhalten Aufwand, Tokens, Nutzen und Kosten.
2. **Ausarbeitung** (`draftRequirements`): Idee mit Status `requested` → der Auftragsautor erzeugt einen Backlog-Auftrag. Die Sprint-Zuordnung bleibt manuell.
3. Hängende `drafting`-Ideen werden nach einer Frist zurückgesetzt.

## 3. Sprint-Lebenszyklus

| Status | Bedeutung |
|---|---|
| Geplant | Sprint angelegt, Aufträge zuordenbar; der Worker arbeitet nichts ab. |
| Aktiv | Maximal **ein** aktiver Sprint pro Projekt (DB-Constraint). Backlog-Aufträge des Sprints werden automatisch auf „Geplant“ gesetzt und abgearbeitet. |
| Abgeschlossen | Sprint-Bericht wird erzeugt; die Git-Sicherung wird automatisch eingereiht (DB-Trigger). |

## 4. Abarbeitung eines Auftrags (`runWorkItem`)

- **Auswahl:** Status `planned` und (Sprint aktiv **oder** fester Agent **oder** `auto_run`). Reihenfolge: Priorität hoch → niedrig, dann Alter. Ein Auftrag nach dem anderen pro Projekt.
- **Sperre:** Pro Auftrag nur ein Lauf (`agent_runs` mit Status `running` ist eindeutig); Läufe älter als 3 h gelten als fehlgeschlagen.
- **Agents:** Aktivierte Agents laufen nach Phase (`pre_task`, `while_task`, `after_task`) und Position. Der erste fehlgeschlagene Schritt beendet den Lauf.
- **Nach jedem Schritt:** Dokumentierer → Auftragsdoku, Handbuch-Autoren → Handbücher, Entwickler bei Bug-Aufträgen → Fix-Notiz am Bug.
- **Abbruch:** Der Nutzer kann einen Lauf abbrechen (Status Blockiert). Beim Herunterfahren des Workers wird der Auftrag zurück auf „Geplant“ gesetzt und läuft beim nächsten Start weiter.
- **Einzelner Agent (Play-Knopf):** Läuft nur dieser Agent; danach wird der frühere Status wiederhergestellt. Es gibt dabei **keinen** Auftrags-Commit und keine automatische Wiederaufnahme.

## 5. Fehlerbehandlung und Auto-Bugfix

1. Ein Schritt scheitert → Auftrag wird **Blockiert**, der Fehler am Auftrag gespeichert, ein **Bug-Bericht** angelegt.
2. Ist `auto_bugfix` am Projekt aktiv (Standard), entsteht **einmalig** ein Bug-Auftrag (hohe Priorität, `auto_run`, auch ohne Sprint).
3. Ist der Bug-Auftrag erfolgreich, wird der Ursprungsauftrag erneut geplant (`auto_run`). **Höchstens 2 automatische Wiederholungen** (`retry_count`).
4. Scheitert ein Bug-Auftrag selbst, entsteht kein weiterer Bug (keine Endlosschleife); stattdessen wird eine Problemanalyse durch den Assistenten angefordert (nur lesend, Rolle `analyst`).
5. `backfillFailures` holt Bug-Berichte für ältere blockierte Aufträge nach.

## 6. Git im Sprint

| Zeitpunkt | Aktion |
|---|---|
| Auftrag im Sprint **erfolgreich** | Lokaler Commit im Projektordner, Conventional Commits: `feat(<Sprint>): <Titel>`, Bug-Aufträge `fix(...)`. Kein Push. Ohne Änderungen kein Commit. |
| Sprint abgeschlossen oder „Git sichern“ | Sammel-Commit (`Sprint: <Name>`) mit restlichen Änderungen, Tag `sprint-<name>-<id>`, Push (Branch + Tag), falls ein Repository am Projekt hinterlegt ist. |

Ausgeschlossen bleiben `.env`, `.dev-log/` und `.dev-log-backups/` (per `.git/info/exclude`). Alle Git-Aktionen laufen unter der Projektsperre, damit sie sich nicht mit Agent-Befehlen überschneiden.

Bekannte Eigenheit: Scheitert ein Auftrag, bleiben seine Dateiänderungen uncommittet und landen im Commit des nächsten erfolgreichen Auftrags bzw. im Sammel-Commit.

## 7. Nach dem Zyklus

Repo-Dokumentation spiegeln (`syncRepoDocs`), Sprint-Bericht für den aktiven Sprint aktualisieren, danach Git-Sicherung ausstehender Sprints.

## 8. Bewertung der Logik (Stand der Prüfung)

**Konsistent:** keine Doppelläufe, keine Endlosschleifen beim Auto-Bugfix, Unterbrechungen sind wiederaufnehmbar, Sprint-Abschluss löst die Sicherung zuverlässig aus.

**Bewusste Grenzen:**
- Aufträge laufen sequenziell pro Projekt; mehrere Projekte parallel (`maxConcurrentAgents`).
- Nach erfolgreichem Play-Lauf eines Bug-Auftrags wird der Ursprungsauftrag nicht automatisch fortgesetzt.
- Auftrags-Commits werden nicht gepusht; erst die Sprint-Sicherung pusht.
