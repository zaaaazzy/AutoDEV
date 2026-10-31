# Tour „Sprint starten“ wählt falsche Sprints und scheitert mit 409

Auftrag 352ebc80 (Bugfix, Schwere niedrig, Fund der Gesamtprüfung vom 21.10.2026, Bereich Frontend).

## Problem

Der Tour-Schritt „Sprint jetzt starten“ nahm als Kandidaten alle Sprints außer `completed`, also auch `active`, `cancelled` und `review`. Der PATCH auf `active` scheiterte dann mit 409. `perform` fängt Fehler ab und wirft nicht, deshalb rief die Tour trotzdem `tour.next()` auf. Der nächste Schritt („Agent live beobachten“) erschien, obwohl nichts gestartet war.

## Umsetzung

`startSprint` in `frontend/src/app/features/tour/first-steps.tour.ts`:

- **Aktiver Sprint:** Läuft schon einer, wird nichts gesendet und mit `tour.next()` weitergegangen (kein PATCH, keine Meldung).
- **Filter:** Nur Sprints mit `status === 'planned'` und mindestens einem Auftrag mit `status === 'planned'`. Der Fallback `?? candidates[0]` ist entfernt, `cancelled`- und `review`-Sprints werden nie angefasst.
- **Meldungen getrennt:** Gibt es einen geplanten Sprint ohne geplante Aufträge: „Ziehe zuerst Aufträge in deinen geplanten Sprint.“ Gibt es keinen geplanten Sprint: „Lege zuerst einen Sprint an und ziehe Aufträge hinein.“ In beiden Fällen kein PATCH und kein `next()`.
- **Weiter nur nach Erfolg:** Die Aktion setzt innerhalb von `perform` ein Merker-Flag `started` nach dem erfolgreichen PATCH. `tour.next()` läuft nur, wenn es gesetzt ist. `perform` selbst blieb unverändert, damit andere Aufrufer nicht betroffen sind. Bei einem Fehler erscheint die Fehlermeldung von `perform`, die Tour bleibt auf dem Schritt.

## Tests

Neu: `frontend/src/app/features/tour/first-steps.tour.spec.ts` (`api.patch` und `store.perform` sind Attrappen; das nachgebaute `perform` fängt Fehler wie das echte). Fünf Fälle:

1. Aktiver Sprint: kein PATCH, keine Meldung, `next()` einmal.
2. Nur `cancelled`, `review` oder `completed`: kein PATCH, kein `next()`.
3. Geplanter Sprint ohne Aufträge: kein PATCH, passende Meldung.
4. Geplanter Sprint mit geplantem Auftrag: PATCH auf `active` mit kodierter ID, dann `next()`; ein abgebrochener Sprint daneben wird übergangen.
5. PATCH schlägt mit 409 fehl: kein `next()`, Fehlermeldung erscheint.

Die Dokumentation hat die Tests nicht ausgeführt. Der Entwickler durfte sie nicht starten und bat den Tester um `tsx --test frontend/src/app/features/tour/first-steps.tour.spec.ts` und `tsc -p frontend/tsconfig.spec.json --noEmit`.

## Geänderte Dateien

- `frontend/src/app/features/tour/first-steps.tour.ts`
- `frontend/src/app/features/tour/first-steps.tour.spec.ts` (neu)

Backend, API und Datenbank sind unverändert.

## Worauf zu achten ist

- Läuft schon ein Sprint, überspringt „Sprint jetzt starten“ den Start still. Das kann ins Benutzerhandbuch (Tour-Kapitel).
- Neuer Tour-Schritt mit PATCH: `perform` meldet Erfolg nicht zurück. Wer danach etwas nur bei Erfolg tun will, braucht ein Flag wie hier.
- Die früheren „offenen“ Bug-Einträge (Bug-Wächter, Ausgabenlimit) sind reine Abbrüche durch das Limit und haben mit diesem Code nichts zu tun.
