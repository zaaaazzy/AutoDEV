# Bug-Wächter: Git-Verlauf und Sprint-Review (Auftrag c30ff9d9)

Stand: 29.10.2026. Hinweis an den Entwickler, vor der Umsetzung lesen.

## Ergebnis der Bug-Prüfung
- Alle bekannten Bugs mit „Bug-Wächter“ im Titel (offen wie behoben) sind **keine Code-Fehler**. Der Lauf brach sofort mit „You've hit your monthly spend limit“ ab. Sie sagen nichts über diesen Auftrag aus. Den Fall nicht als Code-Ursache deuten und nicht „reparieren“.
- Im selben Kontext liegt nur der offene Bug „Git-Verlauf und Sprint-Review: Fehlerzustand und weniger…“ (derselbe Auftrag, ebenfalls Limit-Abbruch, kein inhaltlicher Befund).
- Relevant ist stattdessen der Vorgänger `docs/frontend-listener-polling-css-fokus-2026-10-21.md` (Auftrag 838b0cb4).

## Befund im Code (Stand dieser Sitzung)
- `git-graph.store.ts`: Der `effect` setzt `graph` bei jedem Projektwechsel auf `null` (richtig), `load()` aber auch bei jedem Ladefehler (`.catch(() => null)` → `result?.graph ?? null`). Fehler und „kein Git-Verlauf“ sind nicht unterscheidbar. Außerdem setzt `load()` `loaded` immer auf `true`.
- Der Store nutzt schon `visibleInterval` (`core/visible-interval.ts`). Der Teil „bei `document.hidden` nicht abfragen“ ist dort also erledigt. Prüfen, ob `git-graph-backdrop.component.ts` und `git-graph-panel` noch eigene Timer haben, und nicht doppelt einbauen.
- `sprint-review.component.ts:99-105`: Jede Instanz startet `visibleInterval` alle 5 s und ruft darin `launch.loadSlots()` und `/commits` auf. `loadSlots()` gehört in einen gemeinsamen Poll (wie `ReviewStateService`/`review-launch.service.ts`), nicht in jede Instanz. `/commits` bleibt je Sprint, aber nur bei sichtbarem Tab.

## Nicht wiederholen
1. **Neue Timer nur mit `visibleInterval`**, Aufräumen über `onCleanup`/`DestroyRef`. Kein `setInterval`, kein eigener `visibilitychange`-Listener ohne Entfernen (Listener-Leck aus Auftrag 838b0cb4).
2. **Fehler dürfen den alten Stand nicht löschen.** Bei Fehler `graph` behalten, eigenen Fehlerzustand (z. B. `error`-Signal) setzen, bei Erfolg zurücksetzen. Nur beim Projektwechsel `graph` leeren, sonst zeigt Projekt B kurz die Daten von A. Die Prüfung `slug !== activeProject()` nach dem `await` beibehalten.
3. **Leer ≠ Fehler:** Panel und Dekoration müssen „leer“ (Antwort ohne Graph) und „Fehler“ getrennt anzeigen. Fehlermeldung auf Deutsch, mit `role="alert"` wie bei `launch.error()`. Nach einem Fehler beim ersten Laden (`graph` noch `null`) die Fehlermeldung zeigen, nicht „leer“.
4. **Sprint-Review nur bei `planned`, `active`, `review` einbinden** (in `sprint-detail.component.html:37-39`), die Statusliste an einer Stelle halten. Prüfen, dass `sprint-review` auch an anderen Stellen (Popover mit `compact`) richtig bleibt und bei Statuswechsel sauber ein- und ausgehängt wird (kein hängender Timer).
5. **Gemeinsamen Poll nicht pro Instanz anlegen:** Mehrere aufgeklappte Sprints dürfen `/api/review-slots` nur einmal pro Takt laden. Fehler von `loadSlots()` bleiben abgefangen, die Commit-Auswahl muss ohne Container-Status sichtbar bleiben (bestehendes Verhalten).
6. **Tests zuerst:** Unit-Test für den Store (Fehler behält alten Stand und setzt Fehlerzustand, Erfolg löscht ihn, Projektwechsel leert) und für die Sprint-Detail-Bindung (abgeschlossene Sprints binden kein `app-sprint-review`). Mit `fakeAsync`/Fake-Timer prüfen, dass der Slots-Abruf bei zwei Instanzen nur einmal pro Takt läuft.
7. **Doku:** Kurze Datei unter `docs/` und Benutzerhandbuch anpassen, falls die Fehleranzeige sichtbar wird.

@@NACHRICHT an Entwickler: Siehe docs/bug-waechter-git-verlauf-sprint-review-2026-10-29.md. Die „Bug-Wächter“-Bugs sind reine Limit-Abbrüche, keine Code-Fehler. Der Git-Verlauf-Store nutzt schon visibleInterval; offen sind Fehlerzustand (alten Graph behalten) und gemeinsamer Slots-Poll plus Statusfilter im Sprint-Detail.
