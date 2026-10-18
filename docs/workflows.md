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

1. **Idee anlegen:** Aufwand, Tokens, Nutzen und Kosten sind optional und lassen sich manuell eintragen.
2. **Auftragsautor** (`draftRequirements`): Idee mit Status `requested` → der Autor erhält Projektbeschreibung und Regeln (Einstellungen) und erzeugt in **einem Lauf** die Anforderung (Ziel, Akzeptanzkriterien, betroffene Dateien, Diagramme) und die Schätzung (Stunden, Tokens, Nutzen, Kosten). Manuell eingetragene Werte bleiben erhalten; die Schätzung wird in den Backlog-Auftrag übernommen.
3. **Bug-Wächter** (`assessRisks`): übernimmt die Anforderung des Autors, prüft sie gegen alle bisherigen Bugs (offene und behobene samt Lösung) und speichert die Risiken am Auftrag („was nicht wiederholt werden darf“). Beide Schritte laufen beim Ausarbeiten und werden bei der Abarbeitung nicht wiederholt.
4. Die Sprint-Zuordnung bleibt manuell. Hängende `drafting`-Ideen werden nach einer Frist zurückgesetzt.

## 3. Sprint-Lebenszyklus

| Status        | Bedeutung                                                                                                                                           |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Geplant       | Sprint angelegt, Aufträge zuordenbar; der Worker arbeitet nichts ab.                                                                                |
| Aktiv         | Maximal **ein** aktiver Sprint pro Projekt (DB-Constraint). Backlog-Aufträge des Sprints werden automatisch auf „Geplant“ gesetzt und abgearbeitet. |
| Abgeschlossen | Sprint-Bericht wird erzeugt; die Git-Sicherung wird automatisch eingereiht (DB-Trigger).                                                            |

## 4. Abarbeitung eines Auftrags (`runWorkItem`)

- **Auswahl:** Status `planned` und (Sprint aktiv **oder** fester Agent **oder** `auto_run`). Reihenfolge: Priorität hoch → niedrig, dann Alter. Bis zu 3 Aufträge pro Durchgang; Entwickler und Tester arbeiten aber nie gleichzeitig an zwei Aufträgen (siehe unten).
- **Sperre:** Pro Auftrag nur ein Lauf (`agent_runs` mit Status `running` ist eindeutig); Läufe älter als 3 h gelten als fehlgeschlagen.
- **Agents:** Aktivierte Agents laufen nach Phase (`pre_task`, `while_task`, `after_task`) und Position. Der erste fehlgeschlagene Schritt beendet den Lauf.
- **Informationsfluss:** Entwickler erhalten Anforderung und Risiken; jeder Agent bekommt die Ergebnisse der vorherigen Agents (Entwickler: Dateiliste → Tester → Dokumentierer → Handbücher).
- **Nach jedem Schritt:** Dokumentierer → Auftragsdoku, Handbuch-Autoren → Handbücher, Entwickler bei Bug-Aufträgen → Fix-Notiz am Bug.
- **Abbruch:** Der Nutzer kann einen Lauf abbrechen (Status Blockiert). Beim Herunterfahren des Workers wird der Auftrag zurück auf „Geplant“ gesetzt und läuft beim nächsten Start weiter.
- **Einzelner Agent (Play-Knopf):** Läuft nur dieser Agent; danach wird der frühere Status wiederhergestellt. Es gibt dabei **keinen** Auftrags-Commit und keine automatische Wiederaufnahme.

## 5. Fehlerbehandlung und Auto-Bugfix

1. Ein Schritt scheitert → Auftrag wird **Blockiert**, der Fehler am Auftrag gespeichert, ein **Bug-Bericht** angelegt.
   Ausnahme: Scheitert der Agent selbst (Zeitlimit, Schleife, Schrittlimit, keine Dateien geändert, Modell nicht erreichbar, Befehl nicht gefunden), entsteht **kein** Bug und kein Bug-Auftrag – der Auftrag bleibt blockiert und die Problemanalyse wird angefordert.
2. Ist `auto_bugfix` am Projekt aktiv (Standard), entsteht **einmalig** ein Bug-Auftrag (hohe Priorität, `auto_run`, auch ohne Sprint).
3. Ist der Bug-Auftrag erfolgreich, wird der Ursprungsauftrag erneut geplant (`auto_run`). **Höchstens 2 automatische Wiederholungen** (`retry_count`).

4. Scheitert ein Bug-Auftrag selbst, entsteht kein weiterer Bug (keine Endlosschleife); stattdessen wird eine Problemanalyse durch den Assistenten angefordert (nur lesend, Rolle `analyst`).
5. `backfillFailures` holt Bug-Berichte für ältere blockierte Aufträge nach.

**Wiederholung:** Ein blockierter Auftrag lässt sich in der Auftragsansicht und im Sprint („Erneut versuchen“) neu starten. Nach einem fehlgeschlagenen Lauf laufen nur der fehlgeschlagene Agent und die folgenden erneut; vorher erfolgreiche Agents werden übersprungen, ihre Ausgabe geht weiter an die Nachfolger.

**Behoben und dokumentiert:** Schließt der Bug-Auftrag erfolgreich ab, setzt ein DB-Trigger den Bug auf „Behoben“. Die Lösung (Ausgabe des Entwicklers) steht am Bug (`fix_notes`) und wird allen späteren Agents als „bekannte Bugs mit Lösung“ mitgegeben. Der Bug-Fix lässt sich per Klick am Bug, am Auftrag oder im Sprint starten.

## 6. Git im Sprint

| Zeitpunkt                                         | Aktion                                                                                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vor einem Sprint-Auftrag                          | Wechsel auf den Sprint-Branch `sprint/<name>` (bei Bedarf von `main` angelegt).                                                                                           |
| Auftrag im Sprint **erfolgreich**                 | Lokaler Commit auf dem Sprint-Branch, Conventional Commits: `feat(<Sprint>): <Titel>`, Bug-Aufträge `fix(...)`. Kein Push. Ohne Änderungen kein Commit.                   |
| Auftrag **fehlgeschlagen**                        | Die vom Auftrag geschriebenen Dateien werden als Stash (`devlog-wip …`) geparkt und landen nicht im nächsten Commit; beim erneuten Versuch werden sie wiederhergestellt.  |
| Sprint-Sicherung (Pfeil-hoch neben GitHub-Symbol) | Reständerungen committen, **Test-Gate** (Projekttests), nur bei grünen Tests Push des Sprint-Branches.                                                                    |
| Sprint abgeschlossen                              | Zusätzlich Merge des Sprint-Branches nach `main` (`--no-ff`), erneutes Test-Gate, Push von `main` und Tag `sprint-<name>-<id>`. Bei Merge-Konflikten Abbruch mit Meldung. |
| Git Download (Pfeil-runter)                       | `git pull --ff-only origin <Branch>` im Projektordner; lokale Änderungen oder abweichende Historie brechen mit Meldung am Sprint ab.                                      |

Ausgeschlossen bleiben `.env`, `.dev-log/`, `.dev-log-backups/` sowie typische Schlüsseldateien (`*.pem`, `*.key`, `id_rsa*`, `.netrc`, `credentials.json` …) per `.git/info/exclude`. Zusätzlich prüft jeder automatische Commit die hinzugefügten Zeilen auf Zugangsdaten (private Schlüssel, GitHub-, AWS-, Anthropic-, OpenAI-, Slack- und Google-Tokens); betroffene Dateien bleiben uncommittet im Arbeitsverzeichnis und werden im Log gemeldet. Alle Git-Aktionen laufen unter der Projektsperre, damit sie sich nicht mit Agent-Befehlen überschneiden.

## 7. Nach dem Zyklus

Repo-Dokumentation spiegeln (`syncRepoDocs`), Sprint-Bericht für den aktiven Sprint aktualisieren, danach Git-Sicherung ausstehender Sprints.

## 8. Bewertung der Logik (Stand der Prüfung)

**Konsistent:** keine Doppelläufe, keine Endlosschleifen beim Auto-Bugfix, Unterbrechungen sind wiederaufnehmbar, Sprint-Abschluss löst die Sicherung zuverlässig aus.

**Bewusste Grenzen:**

- Aufträge laufen sequenziell pro Projekt; mehrere Projekte parallel (`maxConcurrentAgents`).
- Nach erfolgreichem Play-Lauf eines Bug-Auftrags wird der Ursprungsauftrag nicht automatisch fortgesetzt.
- Auftrags-Commits werden nicht gepusht; erst die Sprint-Sicherung pusht (nur bei grünen Tests).

## Parallelität

- **Auftragsautor:** Läuft in eigener Schleife des Workers und schreibt Anforderungen, während andere Aufträge entwickelt werden.
- **Schnellschätzung:** Läuft ebenfalls unabhängig.
- **Aufträge:** Der Worker nimmt bis zu 3 geplante Aufträge pro Durchgang (`--limit 3`). Ab dem ersten Agent, der Dateien ändert (Phase „Umsetzung“ sowie Entwickler und Tester in jeder Phase), hält ein Auftrag die Projektsperre bis einschließlich Auftrags-Commit. So testet und committet der Tester nie halbfertige Änderungen eines anderen Auftrags. Vorbereitung und Nachbereitung (Dokumentierer, Handbuch-Autoren) laufen parallel zur Umsetzung eines anderen Auftrags.
- Grenze: Der Git-Commit eines Auftrags kann Änderungen enthalten, die ein parallel laufender Auftrag schon im Arbeitsverzeichnis hat.

## Deploy nach Aufträgen

Pro Projekt lassen sich in den Einstellungen Deploy-Befehle hinterlegen (z. B. `docker compose up -d --build`). Der Worker führt sie im Projektordner aus, sobald ein Zyklus mindestens einen erfolgreichen Auftrag hatte. So laufen Container mit dem Code der Agents. Das Ergebnis steht in den Einstellungen.
