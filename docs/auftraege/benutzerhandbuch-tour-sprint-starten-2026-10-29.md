# Benutzerhandbuch: Tour „Sprint starten“

Stand: 29.10.2026 · Gehört zum Auftrag 352ebc80 (Bugfix, Tour „Sprint starten“ wählt falsche Sprints und scheitert mit 409).

## 1. Worum es geht

Die Erste-Schritte-Tour führt dich am Ende durch den Schritt **„Sprint starten?“**. Dort kannst du den Sprint mit einem Klick starten. Die Tour startet dabei nur Sprints, die wirklich startbar sind. Vorher hat sie teils Sprints angefasst, die nicht startbar waren, und ist trotzdem weitergegangen. Das ist behoben.

## 2. Der Schritt „Sprint starten?“

Sichtbar ist der Schritt, sobald du im Bereich **Sprints** bist und die Tour bei diesem Schritt angekommen ist. Er zeigt den Knopf **„Sprint jetzt starten“**.

Was passiert, wenn du den Knopf drückst, hängt vom Zustand deiner Sprints ab:

| Zustand | Was die Tour tut | Meldung |
|---|---|---|
| Es läuft schon ein Sprint (Status „aktiv“) | Nichts wird gestartet. Die Tour geht sofort zum nächsten Schritt. | Keine |
| Es gibt einen geplanten Sprint mit mindestens einem geplanten Auftrag | Der Sprint wird auf „aktiv“ gesetzt. Erst bei Erfolg geht die Tour weiter. | „Sprint „…“ läuft – die Agents legen los.“ |
| Es gibt einen geplanten Sprint, aber ohne geplante Aufträge | Nichts wird gestartet. Die Tour bleibt auf dem Schritt. | „Ziehe zuerst Aufträge in deinen geplanten Sprint.“ |
| Es gibt keinen geplanten Sprint (nur abgebrochene, geprüfte oder abgeschlossene Sprints, oder gar keine) | Nichts wird gestartet. Die Tour bleibt auf dem Schritt. | „Lege zuerst einen Sprint an und ziehe Aufträge hinein.“ |
| Der Start schlägt fehl (z. B. Konflikt mit 409) | Der Fehler wird angezeigt. Die Tour bleibt auf dem Schritt. | „Fehler: …“ |

## 3. Bedingungen

- **Nur geplante Sprints** werden gestartet. Abgebrochene, zur Prüfung stehende („review“) und abgeschlossene Sprints werden nie angefasst.
- **Nur geplante Aufträge** zählen. Ein geplanter Sprint, in dem nur andere Aufträge liegen, gilt als leer.
- **Ein laufender Sprint hat Vorrang.** Ist schon einer aktiv, startet die Tour keinen weiteren und meldet nichts. Das ist gewollt: Der Sprint läuft bereits.
- **Weiter nur nach Erfolg.** Die Tour geht erst zum nächsten Schritt, wenn der Start tatsächlich geklappt hat.

## 4. Was du tun kannst, wenn die Tour stehen bleibt

1. **„Ziehe zuerst Aufträge in deinen geplanten Sprint.“** Öffne unter **Aufträge hinzufügen** die offenen Aufträge und hole mindestens einen mit → in den geplanten Sprint. Danach erneut „Sprint jetzt starten“ drücken.
2. **„Lege zuerst einen Sprint an und ziehe Aufträge hinein.“** Lege unter **Sprints** einen neuen Sprint an, nimm Aufträge hinein und drücke dann erneut „Sprint jetzt starten“.
3. **Fehlermeldung „Fehler: …“.** Der Start wurde vom Server abgelehnt. Lade die Seite neu und prüfe den Sprint-Status im Bereich **Sprints**, bevor du es erneut versuchst.
4. **Ein Sprint läuft schon.** Dann musst du nichts tun. Die Tour springt ohne Meldung weiter. Den laufenden Sprint siehst du oben im Bereich **Sprints**.

## 5. Printscreens (noch nicht erstellt)

Die App ließ sich für diesen Lauf nicht mit Datenbank und Browser starten. Diese Aufnahmen fehlen:

1. **Schritt „Sprint starten?“** mit dem Knopf „Sprint jetzt starten“ und einem geplanten Sprint mit geplanten Aufträgen.
2. **Meldung „Ziehe zuerst Aufträge in deinen geplanten Sprint.“** bei einem leeren geplanten Sprint.
3. **Meldung „Lege zuerst einen Sprint an …“** bei nur abgebrochenen Sprints.
4. **Laufender Sprint** oben im Bereich Sprints, bevor die Tour weiterspringt.

## 6. Grenzen und offene Punkte

- Die Tests zum Schritt liegen in `frontend/src/app/features/tour/first-steps.tour.spec.ts` (fünf Fälle). Sie wurden in diesem Lauf **nicht ausgeführt**. Ausführen mit `tsx --test frontend/src/app/features/tour/first-steps.tour.spec.ts` und `tsc -p frontend/tsconfig.spec.json --noEmit`.
- Das Verhalten im Browser ist **nicht geprüft**, nur im Code gelesen.
- Die Meldung „Fehler: …“ kommt aus dem gemeinsamen Store. Ihr genauer Wortlaut hängt von der Serverantwort ab.

## 7. Verweise

- Auftragsdoku: `docs/tour-sprint-starten-waehlt-falsche-sprints-2026-10-29.md`
- Code: `frontend/src/app/features/tour/first-steps.tour.ts` (Aktion `startSprint`)
- Tests: `frontend/src/app/features/tour/first-steps.tour.spec.ts`
