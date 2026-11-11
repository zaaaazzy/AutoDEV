# Seite „Aktionen“: Abnahme zuerst, Auftragsdetails eingeklappt (11.11.2026)

## Problem

Eine aufgeklappte Zeile unter „Rückmeldungen der Agents“ zeigte zwei grosse Karten „Warum“ und „Lösungsvorschlag“, das Ergänzungsfeld, die Knöpfe und – nach „Details“ – die kompletten Auftragsdetails. Die Abnahme („19 von 19 offen“) stand erst ganz unten in den Auftragsdetails. Was jetzt zu tun ist, war nicht das Erste, was man sah.

## Lösung

Jede Zeile hat jetzt denselben Aufbau in drei Zonen (siehe `docs/laufzeit.md`, Abschnitt 8):

1. Kopfband mit Grund, nächstem Schritt und dem einen Hauptknopf.
2. Arbeitsbereich: die Abnahmeliste zuerst, wenn Punkte offen sind; sonst Freigabe, Rückfrage, Lösungsvorschlag, Aufgabe, Testnachweise, optische Abnahme.
3. „Neu analysieren“ und zwei eingeklappte Falten: „Auftragsdetails“ und „Meldung, Analyse und Protokoll“. Der Knopf „Details“ entfällt.

Neu ist die filterbare Spalte „Zu tun“ (Rückfrage, Freigabe, Abnahme, Testnachweis, Abgelehnt, Einplanen, Aufgabe für dich, Erneut versuchen, Läuft).

## Änderungen

- `frontend/src/app/features/development/acceptance-list.component.ts` (neu): offene Abnahmepunkte mit Häkchen, „🤖 Prüfen“, „🤖 Alle automatisch prüfen“, „Geprüft – alles in Ordnung“ (nur mit manuellen Punkten) und eingeklappten erfüllten Punkten. Die Auftragsansicht („Noch zu erledigen“) nutzt dieselbe Komponente.
- `frontend/src/app/shared/order-attention.ts`: je Eintrag `acceptance` (offen, erfüllt, manuell) und `task` (Spalte „Zu tun“). Der Abnahmehinweis „Selbst prüfen: …“ gilt nicht mehr als eigene Aktion – ein erledigter Auftrag mit manuellen Punkten fiel bisher aus der Liste, sobald der Worker diesen Hinweis gesetzt hatte.
- `src/core/shared-types.ts`: `MANUAL_TODO_PREFIX` liegt jetzt dort, damit Oberfläche und Worker denselben Wert lesen; `src/runner/action-todo.ts` exportiert ihn weiter.
- `frontend/src/app/features/actions/actions.component.*`: neuer Aufbau der Zeile, Spalte „Zu tun“, Auftragsdetails erst beim Öffnen der Falte gerendert.
- `frontend/src/app/shared/needs-visual.ts`: aus `features/development` verschoben (von Aktionen und Auftragsansicht genutzt).
- `frontend/src/styles/09-dashboard.css`: Kopfband, Arbeitsbereiche, Falten, Farben der Spalte „Zu tun“ – nur über Variablen.
- Specs: `order-attention.spec.ts` (Reihenfolge der Punkte, Spalte „Zu tun“, „Selbst prüfen“-Hinweis), `action-hints.spec.ts`; E2E-Tests auf die Falte „Auftragsdetails“ umgestellt.

## Abwägung: Status „Abnahme“

Kein neuer Datenbank-Status. Manuelle Punkte entstehen nach dem Merge (Status `done` oder `approval`); ein Status davor hiesse, den Merge aufzuhalten, und überschnitte sich mit `approval`. Die Art „Abnahme“ in der Spalte „Zu tun“ macht den Fall sichtbar, ohne Übergänge, Autopilot oder Berichte zu ändern. Falls der Status später doch gewünscht ist: `DEVELOPMENT_STATUS.acceptance` in `src/core/status.ts`, Übergänge `in_progress → acceptance → approval | done | planned` in `development-transitions.ts`, Etikett in `labels.ts`, `SPRINT_BOUND_STATUSES` und `SPRINT_LOCKED_DEVELOPMENT_STATUSES` erweitern, Merge hinter die Abnahme rücken.

## Unverändert

Einzelfreigabe, API der Abnahme-Häkchen, Merge-Logik, Status-Werte.
