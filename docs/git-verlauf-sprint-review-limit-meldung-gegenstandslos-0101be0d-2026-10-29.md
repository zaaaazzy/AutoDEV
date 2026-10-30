# Git-Verlauf und Sprint-Review: Auftrag gegenstandslos (Limit-Meldung)

Auftrag 0101be0d (Bugfix). Titel: „Bug-Wächter: Git-Verlauf und Sprint-Review: Fehlerzustand und weniger…“.

## Problem

- Die gesamte Fehlerbeschreibung des Bugs lautet: „You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage … resets 8:50pm (Europe/Zurich)“. Das ist die Abbruchmeldung der Claude-CLI, kein Fehler im Git-Verlauf oder im Sprint-Review.
- Der Bug-Wächter-Lauf brach am Kostenlimit ab, bevor er etwas geprüft hatte. Aus der Meldung wurde ein Bug und daraus dieser Behebungsauftrag.
- Mindestens 11 weitere „Bug-Wächter“-Bugs (alle als behoben markiert) haben dieselbe Ursache.

## Ursache

- Das Muster `USAGE_LIMIT` in `src/runner/autofix.ts` erkannte bis Commit `cff88be` (gemergt am 28.10.2026, 22:02) nur ein Wort vor „limit“. „monthly spend limit“ hat zwei Wörter und wurde deshalb nicht als Nutzungslimit erkannt.
- Der heutige Code fängt diese Meldung ab. Abgedeckt ist das durch den Test „Nutzungslimit des Agent-Kontos…“ in `src/runner/autofix.test.ts` (Zeilen 131–134).

## Umsetzung

Es wurde kein Code geändert. Der Entwickler hat keinen reproduzierbaren Fehler im Git-Verlauf oder im Sprint-Review gefunden und empfiehlt, den Auftrag als gegenstandslos zu schliessen.

## Geänderte Dateien

Keine (ausser dieser Dokumentation).

## Sprint

| Auftrag | Titel | Art | Zustand |
|---|---|---|---|
| 0101be0d | Bug-Wächter: Git-Verlauf und Sprint-Review: Fehlerzustand und weniger… | Bugfix | gegenstandslos, kein Code geändert; Tests nicht ausgeführt |

## Anfrage / TODO

- Anfrage: automatisch erzeugter Bug, dessen Text nur aus der Limit-Meldung besteht.
- Tests: Weder der Entwickler noch dieser Schritt durften Tests ausführen. `src/runner/autofix.test.ts` und die Specs des ursprünglichen Auftrags (`frontend/src/app/core/shared-poll.spec.ts`, `frontend/src/app/features/dashboard/git-graph-state.spec.ts`, `frontend/src/app/features/sprints/review-launch.spec.ts`) sind in diesem Lauf nicht geprüft.
- Offen: Auftrag schliessen. Prüfen, ob der Worker seit dem 28.10.2026, 22:02 neu gestartet wurde. Sonst läuft dort noch das alte Muster.
- Offen: Die übrigen Bugs, deren Text nur aus der Limit-Meldung besteht, als „kein Code-Fehler“ verwerfen, vor allem die mit noch offenen Behebungsaufträgen.
- Offen: Die Bug-Wächter-Aufträge, die offene Bugs mit Inhalten wie „Tester: Angular-Builder umstellen“ und „CI CD nicht in Ordnung“ betreffen, sind davon getrennt und nicht Teil dieses Auftrags.

## Technische Dokumentation

- `src/runner/autofix.ts`: `USAGE_LIMIT` erkennt Limit-Meldungen des Agent-Kontos. Seit `cff88be` gehören auch Meldungen mit mehreren Wörtern vor „limit“ („monthly spend limit“) dazu. Solche Läufe erzeugen dann keinen Bug mehr.
- Erkennung gibt es seit dem 21.10.2026 (`e624cc1a`). Die Meldung mit „spend limit“ kam am 28.10.2026 mit `cff88be` dazu.

## Worauf zu achten ist

- Ein Bug, der nur aus „You've hit your monthly spend limit“ besteht, ist kein Code-Fehler. Vor einem Fix zuerst prüfen, ob sich ein echter Fehler reproduzieren lässt.
- Bestehende Bugs aus der Zeit vor `cff88be` bleiben in der Liste stehen und müssen von Hand verworfen werden.
