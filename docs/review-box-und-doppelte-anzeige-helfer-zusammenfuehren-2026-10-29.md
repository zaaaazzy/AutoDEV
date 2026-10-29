# Review-Box und doppelte Anzeige-Helfer zusammenführen

Auftrag 5a2d353b aus dem Code-Review vom 21.10.2026 (Stand `a4971e9`). Stand: 29.10.2026. Sprint 28. Nur Frontend, keine API- oder Datenbankänderung.

## Problem
Die Abnahme-Box auf „Aktionen“ war eine Kopie der Freigabe-Box (`shown`, `instanceLabel`, Start mit `isActive`-Prüfung). Weitere Duplikate: `ciLabel`, das Bug-Präfix im Titel und die Graph-Berechnung in Panel und Rand-Dekoration. Im Sprint-Detail rechneten Methoden wie `sprintItems`, `sprintProgress` und `sprintSpent` bei jeder Änderungsprüfung neu. Eine Änderung an einer Kopie (z. B. neuer Slot-Status) ging in der anderen verloren.

## Was umgesetzt wurde
- **Review-Box:** Neue reine Funktionen in `development/review-box.ts` (mit `review-box.spec.ts`):
  - `orderReviewSlot` – Container, der den Auftrag zeigt (nicht `idle`).
  - `freeReviewSlot` – freier, aktivierter Container.
  - `reviewInstanceLabel` – Statuszeile („läuft“, „startet …“, „konnte nicht starten“, sonst „Wird gestartet …“).
  - `reviewLaunchable` – Start-Knopf nur ohne Container oder nach gescheitertem Start („neu starten“).
  - `launchOrderReview` – startet den Container und lädt den Stand nur nach, wenn das Projekt nicht gewechselt wurde.
- **Gemeinsame Anzeige:** Neue Komponente `review-slot-status.component.ts` (`app-review-slot-status`) zeigt Statuspunkt, Link, Wartestatus und bei Fehler das Log. Freigabe-Box (`order-approval.component.ts`) und Abnahme-Box (`acceptance-review.component.ts`) nutzen sie; die Bedingung für den Start-Knopf (`launchable`) kommt aus derselben Funktion.
- **Start zentral:** `ReviewStateService.launch(item)` ersetzt die zwei Kopien von `show`/`start`.
- **`labels.ts`:** `ciLabel` (vorher in `sprint-detail` und `sprints`) und `orderTitle` (Bug-Präfix „Bug:“ entfernen; vorher in `order-table`, jetzt auch in `sprint-orders`) mit Tests in `labels.spec.ts`.
- **Git-Graph:** `laneColor` und `edgePath` in `git-graph.ts`; `GitGraphStore.layout` (`computed`) wird von Panel und Backdrop gemeinsam genutzt, das Layout wird nur einmal berechnet. Test in `git-graph.spec.ts`.
- **Sprint-Detail:** `report`, `sprintItems`, `sprintProgress`, `sprintEstimate`, `sprintTokensEstimate`, `sprintTokensSpent`, `sprintSpent`, `ciLabel` und `gitNodes` sind jetzt `computed`-Signale aus dem Sprint-Input und den Store-Daten. Das Template (`sprint-detail.component.html`) liest sie ohne Argument.

## Worauf zu achten ist
- Neue Slot-Status oder Texte der Review-Boxen gehören nur noch in `review-box.ts` bzw. `review-slot-status.component.ts`.
- Die `computed`-Werte stützen sich auf den Input-Signal und die Store-Daten, die ersetzt und nie verändert werden. Wer Sprint oder Aufträge künftig an Ort und Stelle verändert, aktualisiert die Anzeige nicht.
- Das Verhalten ist gleich geblieben: gleiche Ausgabe, nur zwischengespeichert. Das Zurücksetzen des Abnahme-Häkchens nach Fehler (siehe `abnahme-haekchen-nach-fehler-zuruecksetzen-2026-10-29.md`) wurde nicht angefasst.
- Der erste Lauf scheiterte am Ausgabenlimit des Kontos (Bug-Wächter), nicht am Code. Die offenen Bug-Einträge dazu sind Folgen des Limits.

## Tests
`review-box.spec.ts` (neu), `labels.spec.ts` und `git-graph.spec.ts` ergänzt. Für diese Dokumentation wurden die Tests nicht ausgeführt. Die CI ist laut Bug-Liste weiterhin offen (eigener Auftrag).

## Geänderte Dateien
- `frontend/src/app/features/actions/acceptance-review.component.ts`
- `frontend/src/app/features/dashboard/git-graph-backdrop.component.ts`
- `frontend/src/app/features/dashboard/git-graph-panel.component.ts`
- `frontend/src/app/features/dashboard/git-graph.spec.ts`
- `frontend/src/app/features/dashboard/git-graph.store.ts`
- `frontend/src/app/features/dashboard/git-graph.ts`
- `frontend/src/app/features/development/order-approval.component.ts`
- `frontend/src/app/features/development/order-table.component.ts`
- `frontend/src/app/features/development/review-box.ts` (neu)
- `frontend/src/app/features/development/review-box.spec.ts` (neu)
- `frontend/src/app/features/development/review-slot-status.component.ts` (neu)
- `frontend/src/app/features/development/review-state.service.ts`
- `frontend/src/app/features/sprints/sprint-detail.component.html`
- `frontend/src/app/features/sprints/sprint-detail.component.ts`
- `frontend/src/app/features/sprints/sprint-orders.component.ts`
- `frontend/src/app/features/sprints/sprints.component.ts`
- `frontend/src/app/shared/labels.ts`
- `frontend/src/app/shared/labels.spec.ts`
