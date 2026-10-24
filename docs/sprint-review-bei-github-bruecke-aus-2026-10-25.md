# Sprint im Review bleibt hängen, wenn die GitHub-Brücke aus ist

Auftrag d31e0350 (Bugfix, 25.10.2026).

## Ziel

Beim Abschluss von Sprint 21 öffnete die Git-Sicherung im PR-Modus den Pull Request #31, der Sprint stand danach auf „review“. Die Abfrage `pollSprintReviews` lief aber nur in `syncGitHub` (`src/runner/github-sync.ts`), und die brach bei `github_mode = 'aus'` sofort ab (`skipped: 'Modus aus'`). Weder der Merge nach grüner CI noch das Erkennen eines von Hand gemergten PR (Tag, `main` nachziehen, Live schalten, CI-Bug schliessen, Sprint `completed`) passierte. Der Sprint blieb für immer im Review.

## Umsetzung

- **`hasSprintReviews`** (`src/runner/github-sync.ts`): neue Hilfsfunktion. Sie prüft, ob das Projekt einen Sprint mit `status = 'review'` und gesetztem `pr_url` hat.
- **`syncGitHub`**: Im Modus `aus` bricht der Takt nur noch ab, wenn kein solcher Sprint existiert. Gibt es einen, läuft der Takt weiter. Nur `settings` fehlt → weiterhin `skipped: 'Modus aus'`.
- **Issue-Import bleibt aus**: `issuesDue` ist bei `aus` immer `false`. Es werden keine Issues gelistet, keine Rückmeldung geschrieben und `github_synced_at` wird nicht verändert.
- **Gleiche Abfrage wie im PR-Modus**: Anmeldung, Remote-Prüfung, Rate-Limit-Pause und Intervall (`REVIEW_INTERVAL_MS`) gelten unverändert. Fehlt Remote oder Anmeldung, wird der Schritt wie bisher mit Hinweis übersprungen. Die Abfrage läuft nicht doppelt und ist idempotent: Ein bereits abgeschlossener Sprint (`completed`) wird beim nächsten Takt nicht noch einmal gemergt.
- Ohne Sprint im Review ruft der Modus `aus` weiterhin kein `gh` auf.

## Tests (`src/runner/git-sync.test.ts`, echtes Git-Repository)

- **Brücke aus, CI grün:** Der PR wird einmal gemergt und getaggt, der Sprint steht auf `completed`. Keine Issues werden gelistet, `github_synced_at` bleibt leer. Der zweite Takt meldet `Modus aus` und mergt nicht erneut.
- **Brücke aus, PR von Hand gemergt:** Der Sprint wird ohne eigenen Merge getaggt und auf `completed` gesetzt.
- Bestehender Test „mode "aus" runs no gh command at all“ in `github-sync.test.ts` gilt unverändert für den Fall ohne Sprint im Review.

## Geänderte Dateien

- `src/runner/github-sync.ts`
- `src/runner/git-sync.test.ts` (2 neue Tests)
- `docs/workflows.md` (Abschnitt „GitHub-Brücke“: Ausnahme für Sprints im Review bei Modus `aus`)

## Worauf zu achten ist

- **Testlauf offen:** Der Entwickler konnte `git-sync.test.ts` und `github-sync.test.ts` nicht selbst ausführen (Freigabe nötig). Der Tester führt sie aus: `npx --no-install tsx --test src/runner/git-sync.test.ts src/runner/github-sync.test.ts`, ohne Coverage-Flags.
- Die bekannten Rotfälle in `secret-holdback.test.ts`, `report-copies.test.ts` und `sprint-reviews-live.test.ts` wurden nicht gegengeprüft.
- Die Alternative („PR-Modus nur wählbar, wenn die Abfrage läuft“) wurde verworfen, weil bereits offene PRs wie #31 so weiter hängen blieben.
- Ohne `gh`-Anmeldung oder GitHub-Remote kann der Sprint auch jetzt nicht abgeschlossen werden; dann bleibt er im Review, bis beides stimmt.
