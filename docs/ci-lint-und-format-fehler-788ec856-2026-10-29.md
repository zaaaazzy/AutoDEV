# CI rot: Lint- und Format-Fehler statt `test:unit`

Auftrag 788ec856 (Bugfix „CI CD nicht in Ordnung“), 29.10.2026.

## Problem

Gemeldet war, dass `npm run test:unit` in der CI fehlschlägt, vermutet wurde ein Folgefehler der Docker-Umstellung.

## Ursache

Nicht `test:unit`, sondern zwei andere Schritte des Jobs `check`:

- **`npm run lint`:** 2× `@typescript-eslint/no-explicit-any` in `scripts/angular-builder.test.ts`.
- **`npm run format:check`:** 6 nicht formatierte Dateien unter `frontend/src`.

Die Docker-Umstellung war nicht beteiligt.

## Umsetzung

- `scripts/angular-builder.test.ts`: die beiden `any` durch konkrete Typen ersetzt (keine Lint-Ausnahme, kein `eslint-disable`).
- Mit Prettier formatiert: `git-graph-state.spec.ts`, `git-graph.spec.ts`, `review-box.spec.ts`, `sprint-actions.spec.ts`, `sprint-actions.ts`, `acceptance-ticks.spec.ts`. Nur Formatierung, keine inhaltliche Änderung.

## Prüfung (laut Entwickler)

- `npm run test:unit`: 1833 von 1833 Tests bestanden (gleiche Zahl wie zuvor, kein Test entfernt oder übersprungen).
- `npm run lint`, `npm run format:check`, `npm run typecheck`: grün.
- Nicht belegt: ein echter Lauf in GitHub Actions. Die Dokumentation hat nichts davon erneut ausgeführt.

## Geänderte Dateien

- `scripts/angular-builder.test.ts`
- `frontend/src/app/features/dashboard/git-graph-state.spec.ts`
- `frontend/src/app/features/dashboard/git-graph.spec.ts`
- `frontend/src/app/features/development/review-box.spec.ts`
- `frontend/src/app/features/sprints/sprint-actions.spec.ts`
- `frontend/src/app/features/sprints/sprint-actions.ts`
- `frontend/src/app/shared/acceptance-ticks.spec.ts`

## Worauf zu achten ist

- **Vor jedem Abschluss** auch `npm run lint` und `npm run format:check` ausführen, nicht nur `test:unit`. Alle drei gehören zum Job `check`.
- **Prettier prüft nur `src` und `frontend/src`**, nicht `scripts/`. Lint deckt `scripts/` ab.
- **Im nächsten echten CI-Lauf bestätigen**, dass `check` grün ist, erst dann den Bug schliessen.
- **Offen, nicht Teil dieses Auftrags:** `@angular-devkit/build-angular` steht noch im Lockfile. `npm ci` scheitert deswegen nicht. Das Aufräumen braucht ein manuelles `npm install` (für Agents gesperrt) und gehört zum Bug „Angular-Builder umstellen“.
- Meldungen mit „spend limit“ in anderen Bug-Einträgen sind keine Code-Fehler.
