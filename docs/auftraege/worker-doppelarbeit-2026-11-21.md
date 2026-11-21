# Weniger Doppelarbeit der Agents im Worker (2026-11-21)

Branch `fix/worker-doppelarbeit`, aufgesetzt auf `main` nach PR #85 (Sandbox-Heuristik) und #86; `main` bis PR #92 (Review-Container, Migration 31) eingemergt.

## Anlass

Beobachtet am 21.11.2026 im Projekt „pianotrainer“:

1. Ein Auftrag hatte Entwickler (27 min, 11 Mio. Tokens) und Tester bestanden und wurde vom Budget-Wächter blockiert.
   Nach „Erneut versuchen“ lief der Reviewer (Lauf B); dann brach Lauf B vor dem Dokumentierer mit `OrderBranchError`
   ab – ohne einen einzigen Schritt. Der nächste Versuch begann wieder beim Entwickler. Insgesamt liefen Entwickler
   und Tester je viermal.
2. „Spotify-Login“ nannte das fehlende Grundgerüst als Abhängigkeit vom Auftrag „Monorepo-Grundgerüst“, lief aber
   vorher (jener war pausiert) und baute das Gerüst ein zweites Mal.
3. Die Claude-CLI des Reviewers legte im Projekt-Repo einen Git-Worktree `.claude/worktrees/agent-<id>/` an (Branch
   `worktree-agent-…`, gesperrt). `foreignChanges` wertete das als fremde Änderung, der Sprint pausierte.
4. Beim Dokumentationsauftrag ohne `package.json` lehnte der Entwickler per `@@REGEL` ab, obwohl seine Arbeit fertig
   auf dem Branch lag; der Auftrag landete auf „abgelehnt“.

## Ursachen

- `resumePosition` (bisher in `src/runner/runner.ts`) sah nur den jüngsten früheren Lauf und dessen Schritte. Ein
  Lauf ohne Schritte lieferte Position 0. Dazu kam ein zweiter Fehler: Die Schritte wurden nach Array-Index mit dem
  Ablauf verglichen, ein fortgesetzter Lauf speichert seine Schritte aber ab der Fortsetzungsposition – der erste
  Schritt (z. B. Reviewer) stand so an Index 0 und passte nicht zum Entwickler, also ebenfalls Position 0.
- Der Worker kannte keine Abhängigkeiten zwischen Aufträgen; die Auswahl ging nur nach `sprint_rank`/Priorität.
- `foreignChanges` kannte nur `.dev-log/` und die Berichtsordner als Ausnahmen.
- `@@REGEL` galt immer als Ablehnung, auch wenn der Agent nur „nichts mehr zu tun“ meinte.

## Änderungen

### 1. Fortsetzen über Läufe hinweg (`src/runner/runner-resume.ts`, neu)

- `resumePosition` liest alle früheren Läufe des Auftrags vom jüngsten rückwärts bis (ausschliesslich) zum letzten
  Lauf mit Status `passed`; Läufe ohne Schritte werden übersprungen, laufende ignoriert.
- Die Schritte jedes Laufs werden der Reihe nach dem nächsten passenden Einsatz zugeordnet (Schlüssel: Workflow-Schritt,
  sonst Agent). Springt eine Zeile zurück (Nachbesserung), zählt ab dort von vorn; spätere Läufe überschreiben frühere.
  Ein späterer Fehlschlag desselben Einsatzes setzt ihn zurück. Beobachter-Schritte und Einsätze, die es im Ablauf nicht
  mehr gibt, bleiben aussen vor.
- Danach wie bisher: Ablehnung von Tester/Reviewer (nicht unterbrochen) → zurück zum Entwickler mit Rückmeldung; alles
  bestanden → der letzte Agent läuft erneut.
- `LOOP_BACK_ROLES` wanderte mit; `runner.ts` importiert beides.

**Abweichung von der Vorgabe:** Ein Reset per „Erneut versuchen“ nach einem fachlichen Fehlschlag gilt *nicht* als
eigene Lauf-Grenze. Begründung: `retry_count` steigt auch bei anderen Wegen (Budget-Block ist `blocked`, also zählt
`retryOrder` ihn mit; Wiederaufnahme nach Bugfix; Umgebung), wäre also kein sauberes Signal. Das gewünschte Verhalten
entsteht ohnehin aus der Schritt-Semantik: Ein gescheiterter Tester oder Reviewer schickt den Auftrag zum Entwickler
(mit dessen Rückmeldung, die sonst verloren ginge); ein gescheiterter Entwickler läuft erneut; ein gescheiterter
Dokumentierer läuft erneut, ohne dass Entwickler und Tester (27 Minuten, 11 Mio. Tokens) wiederholt werden.

Tests: `src/runner/runner-resume.test.ts` (8 Fälle: Lauf ohne Schritte, versetzter Start, Erfolg als Grenze, späterer
Fehlschlag, Rückmeldung, Nachbesserung, Beobachter, keine Läufe). Die bestehenden Fortsetzungs-Tests in
`runner.test.ts` laufen unverändert.

### 2. Tester nicht wiederholen, wenn nichts geändert wurde

- Migration 33: `agent_run_steps.commit_sha`. Nach dem Commit jedes Agent-Schritts speichert `recordStepCommit` den
  Stand des Auftrags-Branchs (`git rev-parse HEAD`) am Schritt (`settleOutcome` in `runner-steps.ts`).
- Vor einem Tester-Schritt prüft `takeOverUnchangedTester` (in `runWorkItem`, nach dem Wechsel auf den
  Auftrags-Branch), ob ein bestandener Tester-Schritt desselben Einsatzes mit genau diesem `commit_sha` existiert. Dann
  entsteht ein eigener Schritt „bestanden“ mit der Ausgabe `Bestanden (unverändert seit <Datum Uhrzeit>): …` plus der
  alten Tester-Ausgabe, Verlaufseintrag, und die alte Ausgabe geht über `ctx.done` an die folgenden Agents
  (Reviewer, Dokumentierer). Ein von Hand gestarteter Einzel-Agent (`agent_id`) läuft immer.
- Nur ein Treffer mit Ausgabe zählt (Fake-Pools, die jede Abfrage beantworten, lösen nichts aus).

Test: `runner.test.ts` „Tester: hat er denselben Stand … schon bestanden“ (echtes Git-Repo; Entwickler ohne Änderung →
Tester übernommen, Dokumentierer bekommt die alte Ausgabe; Entwickler mit Änderung → Tester läuft).

Grenze: Ändert sich zwischen den Läufen die Beschreibung (Akzeptanzkriterien), der Commit aber nicht, wird das alte
Tester-Urteil übernommen. In der Praxis läuft davor der Entwickler, der dann meist committet.

### 3. Abhängigkeiten zwischen Aufträgen

- Migration 32: `development_items.depends_on UUID REFERENCES development_items(id) ON DELETE SET NULL` mit Teil-Index.
- Repository (`src/db/development-repository.ts`): `DEV_COLUMNS` liefert `dependsOn`, `dependsOnTitle`,
  `dependsOnStatus`; neu `dependencyAllowed` (gleiches Projekt, nicht selbst, kein Kreis per rekursivem CTE),
  `findOrderByTitle` (ohne Gross-/Kleinschreibung, Anführungszeichen, Leerraum), `loadOpenOrderTitles`, `setDependency`.
- API: `PATCH /development/:id` nimmt `dependsOn` (nullable UUID, `DEV_FIELDS` in `development-input.ts`); ungültig →
  400 „… muss ein anderer Auftrag desselben Projekts sein und darf keinen Kreis bilden“.
- Auftragsautor (`src/agent/requirements.ts`): Der Prompt enthält die Liste der offenen Aufträge des Projekts und die
  Anweisung, bei zwingender Abhängigkeit als zweite Zeile `Hängt ab von: <genauer Titel>` auszugeben. `splitDependency`
  trennt die Zeile ab (auch `@@Hängt ab von:`, „keine“/„–“ = keine); `saveDependency` löst den Titel auf und setzt die
  Spalte beim neuen wie beim überarbeiteten Auftrag. Ein unbekannter Titel wird nur protokolliert.
- Auswahl (`src/runner/runner-selection.ts`): `dependencyDoneSql` filtert Aufträge, deren Abhängigkeit nicht `done` ist;
  dieselbe Bedingung steht im Start-UPDATE von `runWorkItem` (wie `projectPausedSql` aus PR #85). `logWaitingItems`
  meldet je Auftrag einmal pro Worker-Laufzeit „… wartet auf … (Status)“. `--item` startet trotzdem.
- Oberfläche (`frontend/src/app/features/development/`): Im Bearbeiten-Formular das Feld „Hängt ab von“ (Auswahl der
  anderen Aufträge des Projekts, ohne Express und ohne Aufträge, die schon von diesem abhängen); im Auftrag ein Hinweis
  „⏳ Hängt ab von „…“ (Status) – der Worker startet diesen Auftrag erst, wenn jener erledigt ist“ bzw. „✓ … erledigt“
  mit Link; in der Liste die Marke „⏳ wartet“ mit Tooltip. Logik in `frontend/src/app/shared/dependency.ts`
  (`waitsForDependency`). CSS in `08-orders.css` nur mit Tokens (`--warn`, `--warn-soft`, `--green`,
  `--success-surface-alt`).

Tests: `src/runner/dependency-selection.test.ts` (PostgreSQL: Auswahl, `--item`, erledigte Abhängigkeit,
`findOrderByTitle`, Kreise über eine und zwei Stufen, `ON DELETE SET NULL`), `requirements.test.ts` (`splitDependency`,
Auflösen und Setzen beim Entwurf, unbekannter Titel), `migrations.test.ts` (32/33), `dependency.spec.ts` (Frontend).

### 4. Claude-Worktrees der Agents (`src/runner/git-sync/order-branch.ts`)

- `foreignChanges` übergeht unversionierte Pfade unter `.claude/` (Status `??`); versionierte Dateien darin (z. B. ein
  eingechecktes `.claude/settings.json`) zählen weiter als fremd.
- `removeAgentWorktrees(cwd)`: entfernt Worktrees unter `.claude/worktrees/` (erst `unlock`, dann `remove --force
  --force`), löscht `worktree-…`-Branches der CLI nur, wenn sie keine eigenen Commits haben, dann `git worktree prune`;
  den Ordner `.claude/worktrees` löscht sie, wenn nichts darin versioniert ist. Läuft vor jedem Commit eines
  Agent-Schritts (`commitAgentStep`), weil `git add -A` einen Worktree sonst als eingebettetes Repository mitnähme.
- CLI-Einstellungen (`src/agent/tool-permissions.ts`): Die Claude-CLI 2.1.x isoliert Hintergrund-Agents standardmässig in
  Worktrees unter `.claude/worktrees/` (Einstellung `worktree.bgIsolation`, Werte `worktree` | `none`; auch
  `CLAUDE_BG_ISOLATION`). AIdeation gibt jetzt in den `--settings` jedes Agents `"worktree": {"bgIsolation": "none"}`
  mit – für normale Rollen und den Vollzugriff des Assistenten. Ein ausdrückliches `EnterWorktree`/Agent mit
  `isolation: "worktree"` könnte weiterhin einen Worktree anlegen; dafür greift die Aufräumroutine.

Tests: `foreign-changes.test.ts` (Worktree samt Sperre und lokale Einstellungen → Auftrag startet; geänderte versionierte
Einstellung → fremd; `removeAgentWorktrees` mit leerem und mit beschäftigtem Worktree, fremder Worktree bleibt),
`tool-permissions.test.ts` (`bgIsolation: none`).

### 5. Ablehnung bei „nichts zu tun“ (`src/runner/step-evaluation.ts`, `runner-steps.ts`)

- `finishedWorkDespiteRefusal`: Meldet der Entwickler `@@REGEL`, hat der Auftrags-Branch gegenüber der Basis Commits
  (`git rev-list --count base..HEAD` ≥ 1) und ist der Arbeitsbaum sauber (`trackedChanges` leer), gilt der Schritt als
  bestanden; die Ausgabe bekommt den Hinweis „Der Agent hat mit „@@REGEL: …“ abgelehnt, die Arbeit des Auftrags liegt
  aber schon auf dem Branch (n Commits …) – es gab nichts mehr zu tun.“ und der Verlauf einen Eintrag. `registerFailure`
  (Status „abgelehnt“) wird nicht aufgerufen. Scheitert git, gilt die Ablehnung.
- Für Tester, Reviewer und alle anderen Rollen bleibt `@@REGEL` eine Ablehnung.

Tests: `runner-steps.test.ts` (bestanden mit Hinweis; ohne Commits bzw. mit offenen Änderungen abgelehnt; Tester
abgelehnt).

## Doku

`docs/workflows.md` Abschnitt 4 (fünf neue Punkte), `docs/erm.md` (`depends_on`, `commit_sha`).

## Prüfung

`npm run lint && npm run format:check && npm run typecheck && npm run test:unit` grün (Datenbank-Tests liefen gegen
die lokale PostgreSQL), `ng build --configuration production` für die Angular-Templates.

## Nach dem Merge

- Worker neu starten (Migrationen 32/33 laufen beim Start; 31 ist der Review-Container aus PR #92).
- Blockierte bzw. abgelehnte pianotrainer-Aufträge von Hand erneut starten; „Spotify-Login“ im Auftrag unter
  „Bearbeiten“ auf „Monorepo-Grundgerüst“ setzen.
- Offen: Abhängigkeiten in der Sprintplanung (`sprint_rank`) berücksichtigen, damit ein abhängiger Auftrag hinter
  seinem Vorgänger steht; heute wartet er nur.
