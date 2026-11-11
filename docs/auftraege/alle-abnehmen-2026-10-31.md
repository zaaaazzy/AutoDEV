# Alle abnehmen und Register „Anfragen“ (Auftrag fddd9163, 2026-10-31)

## Server

- `POST /api/sprints/:id/approve` (Recht `run`, Mandant `sprints`): alle Aufträge des Sprints im Status Freigabe ohne
  `review_approved_at`.
- `POST /api/projects/:slug/approve` (Recht `run`, Mandant `project`) mit `{ ids }`: Seite „Aktionen“. Die IDs sind die
  im Dialog genannten Umsetzungen; damit nimmt der Klick nie mehr ab, als der Dialog gezeigt hat. Geprüft von
  `parseApproveIds` (`src/api/development-input.ts`, 1–500 UUIDs, doppelte entfernt).
- Beide: `guardGit(…, 'approve', body)` einmal für das Projekt, dann `approveWaitingOrders`
  (`src/db/development-repository.ts`) mit einem UPDATE
  `… AND status = 'approval' AND review_approved_at IS NULL RETURNING id`. Inzwischen geänderte fallen über das WHERE
  heraus. `pg_notify('devlog_work')` genau einmal, nur wenn etwas abgenommen wurde. Antwort `{ approved, ids }`.
- Kein Treffer ist kein Fehler (200 mit `approved: 0`), damit ein Wettlauf mit einer zweiten Sitzung keine Fehlermeldung
  erzeugt.

## Oberfläche

- `sprintButtons` (`features/sprints/sprint-actions.ts`) hat `approveAll`: Recht `run` und mindestens ein Auftrag des
  Sprints mit `awaitsApproval` (gleiches WHERE wie der Server). `src/core/sprint-rules.ts` unverändert.
- `OrderService.approveAll(items, sprintId | null)`: Dialog über `gitGuard.confirmAction('approve', …)`, Texte und
  Ablauf in `features/development/approve-all.ts` (testbar ohne Angular-DI). Das Signal `approving` ist im Dienst und
  sperrt beide Knöpfe; `exclusive` löst es auch nach Abbruch oder Fehler.
- Register in `sprint-detail.component.html`: Reiter als `role="tab"`, Inhalte mit `[hidden]` statt `@if`, damit Zustand
  der Auftragsliste (aufgeklappte Zeile, „Aufträge hinzufügen“) beim Wechsel bleibt. Der Reiter liegt im
  Komponentenzustand und springt beim Nachladen nicht zurück.
- Neu `features/sprints/sprint-requests.component.ts` mit `OrderTableComponent`. Zeilenklick über das neue Input
  `rowOpen` (OrderTable) bzw. `rowLink` (DataTable): `store.navigate('actions', { focus: id })`.
- Bewusste Änderung: Der Abschnitt „Aufträge“ war bei abgeschlossenen Sprints als `<details>` zugeklappt. Als Reiter ist
  er jetzt immer sichtbar.
- `angular.json`: Fehlergrenze des Initial-Bundles von 1.1 MB auf 1.15 MB angehoben. Das Bundle lag schon knapp unter
  der Grenze; dieser Auftrag hat sie um etwa 5 kB überschritten.

## Tests

- `src/api/review-routes.test.ts`: Recht, Statusfilter, Git-Guard (gesperrt und mit Begründung), einmaliges Wecken,
  übersprungene Aufträge, ID-Liste.
- `frontend/src/app/features/sprints/sprint-actions.spec.ts`: Knopfregel `approveAll`.
- `frontend/src/app/features/development/approve-all.spec.ts`: Dialog (Kürzung auf 10), Abbruch ohne Anfrage, Sperre,
  Meldung.
- `frontend/src/app/features/sprints/sprint-requests.spec.ts`: Inhalt und Vermerk des Registers.
- `e2e/app.spec.ts`: Register, Dialog-Abbruch, Abnahme, Vermerk, Zeilenklick (in diesem Lauf nicht ausgeführt).
