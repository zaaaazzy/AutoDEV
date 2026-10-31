# Einzeln gestarteter Agent mergt nicht ungeprüft in die Basis

Auftrag 72d216b7 (Bugfix, Code-Review vom 21.10.2026, Stand `a4971e9`). Sprint 23.

## Ursache

Bei einem Einzellauf (ein Agent, z. B. nur der Entwickler, über `agentId`) ist das Review aus (`review = passed && !item.agentId ? … : 'off'`). `finishOrderBranch` mergte den Auftrags-Branch deshalb sofort in die Basis, ohne Tester, Reviewer oder Freigabe. Bei Aufträgen ohne Sprint und ohne eigenen Worktree landete ungeprüfter Code direkt auf `main`. Danach ging der Auftrag zurück auf `planned` und durchlief den ganzen Ablauf auf schon gemergtem Code.

Die Fundstelle im Auftrag (`runner-steps.ts:903-906`) war veraltet; die Logik liegt in `src/runner/runner-settle.ts` und `src/runner/git-sync/order-branch.ts`.

## Umsetzung

- **`finishOrderBranch`** (`order-branch.ts`) hat den neuen Parameter `keep` (Standard `false`). Bei `keep` wird nur auf dem Auftrags-Branch committet, der Arbeitsordner kehrt zur Basis zurück (`leaveOrderBranch`), der Branch bleibt stehen. Das Ergebnis trägt `kept: true`, `merged: false`.
- **Reihenfolge**: Die Prüfung auf zurückgehaltene Zugangsdaten läuft weiter vor `keep`, danach folgt `keep`, dann erst die Review-Freigabe (`hold`). Der normale Ablauf ist unverändert.
- **`settleItem`** (`runner-settle.ts`) übergibt `keep = Boolean(item.agentId)`. Ein nicht gemergter Einzellauf (`kept`) gilt nicht als Merge-Problem: kein Vermerk in `failure`, kein `git_commit`-Verweis, der Auftrag geht eindeutig auf seinen vorherigen Status zurück.
- **Fortsetzen**: Der nächste normale Lauf nimmt über `enterOrderBranch` denselben Branch samt Commit wieder auf. Gemergt wird erst nach Tester, Reviewer und Freigabe.

## Worauf zu achten ist

- Projekte ohne Git (`ctx.branch` ist `null`) gehen weiter über `commitTaskToGit`. Dieser Weg mergt nicht in die Basis und wurde bewusst nicht geändert.
- Der Einzellauf-Branch bleibt bis zum normalen Ablauf bestehen. Wird der Auftrag nie normal gestartet, bleibt auch der Branch liegen.
- Tests nur über `npm test` bzw. `npm run …`, nicht mit `npx tsx --test` oder Abdeckungs-Flags (blockiert der Wächter).

## Tests

- `src/runner/settle-merge-failure.test.ts`: „Einzellauf eines Agents: main bleibt unverändert, Arbeit liegt committet auf dem Auftrags-Branch“. Prüft den Hash von `main` vor und nach dem Lauf, Arbeitsordner zurück auf der Basis, sauberen Status, Datei auf dem Branch, kein `failure`/`git_commit` und erneutes Betreten desselben Branches.
- Gesamte Suite mit `npm test`: 1566/1566 grün (Stand Entwickler). Die bestehenden Tests `git-sync-safety`, `review-gate` und `agent-workspace` bleiben grün.
- Nicht geprüft: ob der neue Test ohne den Fix scheitert (ohne `keep` würde gemergt und der Hash von `main` änderte sich).

## Geänderte Dateien

- `src/runner/git-sync/order-branch.ts`
- `src/runner/runner-settle.ts`
- `src/runner/settle-merge-failure.test.ts`
- `docs/laufzeit.md` (Abschnitt „Sperre und Parallelität“, Absatz zum Einzellauf)
- `docs/einzellauf-mergt-nicht-in-die-basis-2026-10-25.md` (diese Datei)
