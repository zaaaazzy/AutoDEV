# „Aufträge hinzufügen“ klappt bei jedem Daten-Refresh zu (Auftrag 27a54f19)

Auftrag 27a54f19 (Bugfix, Schwere mittel, Gesamtprüfung vom 21.10.2026, Bereich Frontend). Sprint 23. Der Fehler wurde schon
unter dem Auftrag 9102659f behoben (siehe `auftraege-hinzufuegen-bleibt-offen-2026-10-25.md`); dieser Auftrag führt die
Korrektur im Branch `auftrag/27a54f19-…` zusammen und sichert sie mit dem Regressionstest ab.

## Aufträge

### 27a54f19 – „Aufträge hinzufügen“ klappt bei jedem Daten-Refresh wieder zu

**Ursache.** `poolOpen` war ein `linkedSignal` direkt auf `orders()`. `orders()` liefert nach jeder Änderung von
`store.data()` ein neues Array, auch beim Live-Refresh der Agent-Läufe alle 3 s. Das `linkedSignal` setzte die von Hand
geöffnete Liste auf „zu“ zurück, und `@if (poolOpen())` baute Tabelle, Filter und Auswahl ab.

**Umsetzung.**
- `pool-selection.ts`: `poolOpenState(orders)`. Quelle ist `computed(() => !orders().length)`, also nur „Sprint leer ja/nein“.
  Erst der Wechsel leer ↔ nicht leer setzt wieder die Vorgabe (leer: offen, sonst zu). Von Hand bleibt der Zustand änderbar.
- `sprint-orders.component.ts`: `poolOpen = poolOpenState(() => this.orders())`; kein `linkedSignal`-Import mehr.
- `pool-selection.spec.ts`: Regressionstests für Vorgabe, Refresh der `agentRuns`, Übernahme eines Auftrags („→“, die
  Auswahl bleibt erhalten, der übernommene Auftrag fällt heraus) und den Wechsel leer ↔ nicht leer. Dazu der Test aus
  Sprint 23, dass `canTakeIntoSprint` laufende und freizugebende Aufträge ausschliesst.

**Akzeptanzkriterien.** Erfüllt: Eine von Hand geöffnete Liste bleibt bei Refresh und Übernahme offen; bei leerem Sprint
ist sie anfangs offen, sonst zu.

### Merge von `sprint/sprint-23` in den Auftrags-Branch

Beim Nachziehen gab es Konflikte. Aufgelöst wurde so, dass die Absicht beider Seiten bleibt:

| Bereich | Entscheidung |
| --- | --- |
| `frontend/src/styles/*.css` (02–15, 17) | Stand von sprint-23 (nur Einrückung/Formatierung und entfernte, im Frontend nicht mehr benutzte Klassen wie `.item-card`, `.sprint-status`, `.workflow-card`, `.tool-*`-Duplikate). Neu aus sprint-23: Seitenblättern `.dt-pager`, `.restart-banner`, `.bulk-bar.compact`, `.proposal-calibration`. |
| `sprint-orders.component.ts` | `poolOpenState` (dieser Auftrag) plus `BulkBarComponent` (sprint-23); `linkedSignal` wird nicht mehr importiert. |
| `pool-selection.spec.ts` | Beide Testgruppen, Importe vereint. |
| `doc-search.spec.ts` | Erwartet `&lt;script` (so escaped `escapeHtml`). |
| `e2e/test-ports.ts` | sprint-23: Sperrdatei je Port statt reiner Portprobe. |
| `src/runner/git-sync/stale-lock.ts`, `reconcile.ts` | sprint-23: `clearStaleLocks`/`clearStaleLock`/`lockedFile` (alle `.lock`-Dateien); Basis eines Auftrags-Branchs ignoriert abgeschlossene/abgebrochene Sprints. |
| `sprint-reviews.ts` | sprint-23: main im Live-Ordner wird per Fast-Forward nachgezogen, nur auf Branch main und ohne offene Änderungen; Meldung „… nachgezogen“. |
| `troubleshoot.ts` | `collectFailures` (Blockiergrund aus `failure`/`action_todo`) ersetzt die Einzelabfrage; die Budget-Blockade steht dort schon als „Blockiergrund des Auftrags“, der Sonderfall `budgetReason` entfällt. |
| `bugs-graveyard.test.ts` | Erwartet alle Migrationen ab Version 8 statt nur `[8]`. |
| Docs (`benutzerhandbuch-dashboard-agents.md`, `fortsetzen-…`, `styles-nach-bereich-…`) | Konfliktmarker entfernt, beide Ergänzungen behalten. |

## Sprint

| Auftrag | Zustand | Details |
| --- | --- | --- |
| 27a54f19 „Aufträge hinzufügen“ klappt bei Daten-Refresh zu | umgesetzt, Merge von sprint-23 gelöst | Fix in `pool-selection.ts`/`sprint-orders.component.ts`, Tests in `pool-selection.spec.ts` |
| 9102659f gleicher Titel | umgesetzt (früherer Auftrag) | siehe `auftraege-hinzufuegen-bleibt-offen-2026-10-25.md` |

Laut Entwickler: `npm test` mit `build:ui` 1539/1539 grün, `typecheck` grün, `lint` ohne Fehler.

## Anfrage / TODO

- `format:check` meldet 18 Dateien, genau wie auf sprint-23; die Ursache liegt dort, nicht in diesem Auftrag.
- Der Agent-Wächter blockiert Skripte und `sed`; Konfliktmarker liessen sich nur mit den Datei-Werkzeugen lösen. Ein
  Hilfswerkzeug für Whitespace-Konflikte in CSS wäre ein eigener Auftrag.

## Technische Dokumentation

- Zustand `poolOpen`: `frontend/src/app/features/sprints/pool-selection.ts` (Kommentar an `poolOpenState`). Regel: Ein aus
  einer Liste abgeleiteter Zustand hängt am abgeleiteten Wert (`computed`), nicht an der Liste, die bei jedem Laden neu entsteht.
- Backend von „Aufträge hinzufügen“ (`POST /api/development/:id/take-into-sprint`): `docs/laufzeit.md`, unverändert.
- Geänderte Dateien dieses Auftrags: `pool-selection.ts`, `pool-selection.spec.ts`, `sprint-orders.component.ts`; der Rest
  der Änderungen stammt aus dem Merge von sprint-23.
