# Bug-Wächter: Folgefehler des Spend-Limits (Review-Box und doppelte Anzeige-Helfer)

Auftrag 9224d9a4 (Bugfix). Titel: „Bug: Bug-Wächter: Review-Box und doppelte Anzeige-Helfer zusammenführen“. Stand: 29.10.2026.

## Problem

- Der Bug wurde automatisch angelegt, weil der Schritt „Bug-Wächter“ des Auftrags „Review-Box und doppelte Anzeige-Helfer zusammenführen“ (5a2d353b) fehlschlug.
- Der Wächter hat nie gearbeitet. Die Claude-CLI brach sofort mit „You've hit your monthly spend limit … your session limit resets 8:50pm (Europe/Zurich)“ ab. Diese Meldung wurde als Bug-Text übernommen.
- Ein Code-Defekt liegt nicht vor.

## Umsetzung

**Folge des Spend-Limits, keine Code-Änderung.** Der Entwickler hat die Ursache geprüft und nichts geändert („Ursache: Spend-Limit der Claude-CLI“). Die eigentliche Umsetzung steht in `review-box-und-doppelte-anzeige-helfer-zusammenfuehren-2026-10-29.md` (Benutzerhandbuch: `benutzerhandbuch-review-box-und-doppelte-anzeige-helfer-2026-10-29.md`).

Geprüft wurde:

- `npm run build:ui` lief ohne Fehler durch. Warnungen NG8113, NG8102, NG8107 und das Start-Paket von 1.06 MB (Grenze 950 kB) brechen den Build nicht ab. Sie betreffen andere Komponenten, nicht die Review-Box.
- **Specs nicht ausgeführt:** `review-box.spec.ts`, `labels.spec.ts` und `git-graph.spec.ts` liefen in diesem Lauf nicht, weil die Umgebung `npx --no-install tsx --test …` nicht freigab. Ob sie grün sind, ist offen. Das darf nicht als „grün“ gelten.

## Geänderte Dateien

Keine. (Nur diese Dokumentation wurde ergänzt.)

## Sprint

| Auftrag | Titel | Art | Zustand |
|---|---|---|---|
| 9224d9a4 | Bug-Wächter: Review-Box und doppelte Anzeige-Helfer zusammenführen | Bugfix | ohne Code-Änderung abgeschlossen, Ursache Spend-Limit; Build ok, Specs ungeprüft |

## Anfrage / TODO

- Specs vom Tester ausführen lassen: `npx --no-install tsx --test frontend/src/app/features/development/review-box.spec.ts frontend/src/app/shared/labels.spec.ts frontend/src/app/features/dashboard/git-graph.spec.ts`.
- Neustart von Wächter-Läufen erst nach dem Reset (8:50pm Europe/Zurich) oder mit höherem Limit unter claude.ai/settings/usage, sonst entsteht sofort wieder ein gleicher Bug.
- Builder, `package.json` und Abhängigkeiten gehören zum offenen Builder-Bug und brauchen `npm install`, das Agents nicht dürfen. Das Zurücksetzen des Abnahme-Häkchens nach Fehler ist ein eigener, behobener Bug.

## Technische Dokumentation

- Ausgaben mit „spend limit“ sollen den Lauf als pausiert/Limit markieren und keinen Bug „Bug-Wächter: …“ erzeugen (`runner-steps.ts`, `autofix.ts`). Siehe `bug-waechter-spend-limit-folgefehler-15d12f5b-2026-10-29.md`.

## Worauf zu achten ist

- Vor jeder Fehleranalyse prüfen, ob der Agent wirklich gearbeitet hat.
- Review-Box-Logik nicht erneut duplizieren: Änderungen nur in `review-box.ts` und `review-slot-status.component.ts`.
