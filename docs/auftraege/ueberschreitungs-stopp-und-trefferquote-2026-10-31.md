# Überschreitungs-Stopp und Trefferquote für Schätzungen (31.10.2026)

Auftrag 099e001e. Der Stand aus Sprint 29 lag auf dem Auftrags-Branch und wurde mit `sprint/sprint-30`
zusammengeführt. Sprint 30 brachte parallel die Laufwarnung „Schätzung überschritten“ (nur Anzeige) und die
Gruppen-Kalibrierung je Art, Kategorie und Schrittklasse. Beides bleibt erhalten.

## Was gilt jetzt

- **Ist-Referenz** (`loadActualReference`, `src/agent/estimation.ts`): Kategorie und Art (`feature`/`bug`, Ideen
  ohne Art gelten als `feature`) sind feste Filter. Danach zählt die engste Gruppe mit mindestens 5 Aufträgen:
  Bereichsanzahl und Schrittklasse, sonst nur Bereichsanzahl, sonst nur Schrittklasse, sonst alle Aufträge der
  Kategorie und Art. `loadAuthorReference` ergänzt den Korrekturfaktor der Gruppe (Sprint 30).
- **Ideen-Art:** Migration 27 `ideen-art` (`ideation_items.kind`, Standard `feature`, erlaubt `feature` und `bug`).
- **Überschreitungs-Stopp** (`src/runner/estimate-overrun.ts`): vor jedem Agent-Schritt nach der Budget-Prüfung.
  Gleiche Schwelle wie die Laufwarnung: `estimateOverrun` nutzt jetzt `exceedsEstimate`/`OVERRUN_FACTOR` aus
  `src/core/estimate-overrun.ts`, damit Warnung und Stopp nie auseinanderlaufen. Scheitert die Prüfung, startet der
  Agent nicht (Auftrag unterbrochen, Neustart nach 5 Minuten).
- **Freigabe:** „Erneut versuchen“ (`retryOrder` in `src/db/development-repository.ts`) setzt `budget_since` neu und
  erhöht den Wiederholungszähler bei „Schätzung überschritten“ nicht. `OVERRUN_TODO_PREFIX` liegt deshalb in
  `src/core/estimate-overrun.ts` (die Datenbankschicht importiert nichts aus dem Runner).
- **Statistik** (`GET …/stats`): je Sprint `hitRate` (Trefferquote) neben `hourError`/`tokenError` (Sprint 30),
  dazu `calibration` (Faktor und Messwerte je Herkunft) und `overruns`.

## Tests

`npm run typecheck`, `npm run lint` (0 Fehler), `npm run format:check` und `npm run test:unit` grün bis auf
`src/core/git-guard.test.ts` („Filter aus .git/config …“): Der Test ruft `git` im Arbeitsordner auf, dessen `.git`
im Container auf kein gültiges Repository zeigt. Das liegt an der Umgebung, nicht an diesem Auftrag.
