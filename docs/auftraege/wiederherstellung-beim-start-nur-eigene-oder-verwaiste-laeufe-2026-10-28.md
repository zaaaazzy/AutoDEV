# Wiederherstellung beim Start nur für eigene oder verwaiste Läufe

Auftrag 027c0e61 (Bugfix, Sprint 23). Aus dem Code-Review vom 21.10.2026 (Stand `a4971e9`).

## Problem

`recoverInterruptedRuns` markierte beim Start alle `running`-Läufe projektübergreifend als gescheitert, `killOrphan` beendete Prozesse mit passender Startzeit, auch lebende eines anderen Workers. Startete ein zweiter Worker (Kopie `AIdeation/agent`, Neustart während der alte noch beendet), brach er die Agents des ersten ab.

## Umsetzung

- **Worker-ID** (`src/runner/worker-identity.ts`): `Rechner:Installationsordner:Bereich`, von Hand über `DEV_LOG_WORKER_ID`. Ein Neustart derselben Installation hat dieselbe ID und räumt so die Reste seines Vorgängers auf.
- **Lebenszeichen:** Jeder Worker schreibt alle 20 s (`WORKER_BEAT_MS`) `runner_workers.last_seen` (Zeit der Datenbank). Nach 90 s ohne Zeichen (`WORKER_STALE_SECONDS`) gilt er als beendet.
- **Migration v16** (`src/db/migrations.ts`, mehrfach ausführbar): Tabelle `runner_workers` sowie `agent_runs.worker_id` und `agent_processes.worker_id`.
- **Besitzprüfung beim Start** (`src/runner/runner-cli.ts`, `src/runner/process-registry.ts`): Aufgeräumt wird nur, was dieselbe ID trägt oder deren Worker kein frisches Lebenszeichen hat. Schritte folgen ihrem Lauf (über `run_id`). Fremde Prozesse eines lebenden Workers werden nicht beendet.
- **Altzeilen ohne ID:** Läufe sind verwaist, wenn `worker_heartbeats` ihres Projekts alt ist; Prozesse ohne ID werden immer aufgeräumt.
- **Lebender anderer Worker:** Chat, Autor, Visionär, Analysen, Testanforderungen, Abnahmen und Git-Lösungen bleiben unberührt.
- **`closeOrphanedRuns`** (`runner.ts`) lässt Läufe eines lebenden anderen Workers stehen. Der Intervall-Parameter wird nun auf PostgreSQL gecastet; vorher brach die Abfrage dort immer mit „text * interval“ ab.
- `runner-runs.ts` trägt die Worker-ID beim Anlegen eines Laufs ein.
- `failed > 0` plant weiterhin nichts neu.

## Tests

- `src/runner/worker-recovery.test.ts` (neu): zwei Worker (A frisch, B startet: A bleibt unberührt), alter Heartbeat oder fehlende ID wird aufgeräumt, eigene Läufe nach Neustart, `failed > 0` plant nichts neu.
- Angepasst: `process-registry.test.ts`, `runner-steps.test.ts`.

Die Dokumentation hat die Tests nicht erneut ausgeführt.

## Geänderte Dateien

- `src/runner/worker-identity.ts`, `src/runner/worker-recovery.test.ts`
- `src/db/migrations.ts` (Migration v16)
- `src/runner/process-registry.ts`, `src/runner/process-registry.test.ts`
- `src/runner/runner-cli.ts`, `src/runner/runner-runs.ts`, `src/runner/runner.ts`, `src/runner/runner-steps.test.ts`
- `docs/laufzeit.md`, `docs/erm.md`

## Worauf zu achten ist

- **Gleiche ID, gleicher Bereich:** Zwei Dauer-Worker derselben Installation im selben Bereich hätten dieselbe ID und räumten sich gegenseitig auf. Für `--all` verhindert das die bestehende Advisory-Sperre.
- **Container:** Wechselt der Hostname, `DEV_LOG_WORKER_ID` fest setzen, sonst gilt der Vorgänger erst nach 90 s als verwaist.
- **Nebenwirkung von `closeOrphanedRuns`:** Es funktioniert auf PostgreSQL erst jetzt. Läufe ohne Halter und ohne Lebenszeichen seit 5 min werden beendet; lange Schritte ohne Verlaufseinträge prüfen (Tester).

## Sprint 23 und Anfrage/TODO

- Zustand: Umsetzung abgeschlossen (Entwickler, bestanden), Dokumentation hier. Prüfung durch Tester und Reviewer steht aus.
- Die „Bug-Wächter“-Einträge zu diesem Auftrag waren Abbrüche der Claude-CLI wegen des Ausgabenlimits, keine Code-Fehler.
- TODO: Tester prüft `closeOrphanedRuns` bei langen Schritten; Reviewer prüft die feste Worker-ID je Installation.
